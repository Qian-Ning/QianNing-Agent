//! A loopback HTTP fixture shared by the outbound channel tests.
//!
//! The webhook channel's tests established this fixture: a hand-written HTTP
//! server on `127.0.0.1` that records every request it receives and answers
//! what the test tells it to. It is reachable only over loopback, and its
//! request parser and response writer only mean anything beside the tests that
//! use them, so it lives here once for every channel that needs one.
//!
//! `gate` is the addition the chat channels need: the fixture accepts the
//! request, announces it, and holds the connection open until the test releases
//! it. That lets a test observe the Host while a real channel's send is
//! genuinely in flight — which is how the "no lock across a blocking send"
//! property is proven against the real adapter rather than a fake.

use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;

/// A request the fixture actually received.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SeenRequest {
    pub method: String,
    pub path: String,
    pub content_type: Option<String>,
    pub authorization: Option<String>,
    pub body: Vec<u8>,
}

/// What the fixture answers, and what it saw.
pub(crate) struct FixtureState {
    pub status: u16,
    /// The response body to write with the answer. Empty writes a bodyless
    /// answer (`Content-Length: 0`).
    pub body: String,
    /// Answer with bytes that are not an HTTP response at all.
    pub malformed: bool,
    /// Accept the request and never answer it.
    pub hang: bool,
    /// Accept the connection and close it without answering.
    pub slam: bool,
    /// Accept the connection and close it without reading a thing.
    pub reject: bool,
    /// Answer a 3xx with a `Location` naming this fixture's second route, so a
    /// client that follows redirects reaches it and a client that does not
    /// never does.
    pub redirect: bool,
    /// Accept the request, announce it, and hold the connection open until the
    /// test releases it, then answer `status`.
    pub gate: bool,
    /// The absolute URL an answer's `Location` names, set from the bound
    /// address when [`FixtureState::redirect`] is on.
    pub(crate) location: Option<String>,
    /// How many requests reached the route `location` names.
    pub(crate) redirect_target_hits: usize,
    /// One permit per request that has reached the fixture.
    pub(crate) seen: Arc<Semaphore>,
    /// One permit releases one gated request.
    pub(crate) release: Arc<Semaphore>,
    pub(crate) requests: Vec<SeenRequest>,
}

impl Default for FixtureState {
    fn default() -> Self {
        Self {
            status: 0,
            body: String::new(),
            malformed: false,
            hang: false,
            slam: false,
            reject: false,
            redirect: false,
            gate: false,
            location: None,
            redirect_target_hits: 0,
            seen: Arc::new(Semaphore::new(0)),
            release: Arc::new(Semaphore::new(0)),
            requests: Vec::new(),
        }
    }
}

async fn read_request(stream: &mut TcpStream) -> Option<SeenRequest> {
    let mut buffer = Vec::new();
    let header_end;
    loop {
        let mut chunk = [0u8; 4096];
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(index) = buffer.windows(4).position(|value| value == b"\r\n\r\n") {
            header_end = index + 4;
            break;
        }
        if buffer.len() > 64 * 1024 {
            return None;
        }
    }
    let head = String::from_utf8_lossy(&buffer[..header_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut request = lines.next()?.split_whitespace();
    let method = request.next()?.to_string();
    let target = request.next()?.to_string();
    let mut content_length = 0usize;
    let mut content_type = None;
    let mut authorization = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().to_string();
        match name.trim().to_ascii_lowercase().as_str() {
            "content-length" => content_length = value.parse().unwrap_or(0),
            "content-type" => content_type = Some(value),
            "authorization" => authorization = Some(value),
            _ => {}
        }
    }
    while buffer.len() < header_end + content_length {
        let mut chunk = [0u8; 4096];
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    Some(SeenRequest {
        method,
        path: target.split('?').next().unwrap_or_default().to_string(),
        content_type,
        authorization,
        body: buffer[header_end..header_end + content_length].to_vec(),
    })
}

async fn write_response(stream: &mut TcpStream, status: u16, body: &str, location: Option<&str>) {
    let reason = match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        302 => "Found",
        400 => "Bad Request",
        404 => "Not Found",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Unknown",
    };
    let location = location
        .map(|value| format!("Location: {value}\r\n"))
        .unwrap_or_default();
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\n{location}Connection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

async fn handle_connection(mut stream: TcpStream, state: Arc<std::sync::Mutex<FixtureState>>) {
    if state.lock().expect("fixture state").reject {
        // Close before reading: a TLS client's handshake fails at once instead
        // of waiting out its connect timeout on a peer that answers nothing.
        let _ = stream.shutdown().await;
        return;
    }
    let Some(request) = read_request(&mut stream).await else {
        return;
    };
    let (
        status,
        body,
        malformed,
        hang,
        slam,
        gate,
        location,
        seen,
        release,
        reached_redirect_target,
    ) = {
        let mut state = state.lock().expect("fixture state");
        let reached_redirect_target = state
            .location
            .as_deref()
            .and_then(|url| reqwest::Url::parse(url).ok())
            .is_some_and(|url| url.path() == request.path);
        state.requests.push(request);
        if reached_redirect_target {
            state.redirect_target_hits += 1;
        }
        (
            state.status,
            state.body.clone(),
            state.malformed,
            state.hang,
            state.slam,
            state.gate,
            state.location.clone(),
            state.seen.clone(),
            state.release.clone(),
            reached_redirect_target,
        )
    };
    // Announce the request so a gated test can observe it in flight.
    seen.add_permits(1);
    if reached_redirect_target {
        // Reaching the redirect target is exactly what a client that follows
        // redirects does; it is answered with an acceptance and recorded.
        write_response(&mut stream, 200, "", None).await;
        return;
    }
    if slam {
        let _ = stream.shutdown().await;
        return;
    }
    if malformed {
        let _ = stream.write_all(b"NOT-HTTP\r\n\r\n").await;
        let _ = stream.shutdown().await;
        return;
    }
    if hang {
        std::future::pending::<()>().await;
        return;
    }
    if gate {
        // Hold the connection open until the test releases one permit.
        let _ = release.acquire().await;
    }
    write_response(&mut stream, status, &body, location.as_deref()).await;
}

pub(crate) struct Fixture {
    pub(crate) endpoint: String,
    state: Arc<std::sync::Mutex<FixtureState>>,
    task: tokio::task::JoinHandle<()>,
}

impl Fixture {
    pub(crate) fn requests(&self) -> Vec<SeenRequest> {
        self.state.lock().expect("fixture state").requests.clone()
    }

    pub(crate) fn redirect_target_hits(&self) -> usize {
        self.state
            .lock()
            .expect("fixture state")
            .redirect_target_hits
    }

    /// Wait until at least one request has reached the fixture.
    pub(crate) async fn wait_for_request(&self) {
        let seen = self.state.lock().expect("fixture state").seen.clone();
        seen.acquire().await.expect("fixture is alive").forget();
    }

    /// Release one gated request so the fixture answers it.
    pub(crate) fn release_one(&self) {
        let release = self.state.lock().expect("fixture state").release.clone();
        release.add_permits(1);
    }

    pub(crate) fn stop(self) {
        self.task.abort();
    }
}

pub(crate) async fn fixture(status: u16) -> Fixture {
    fixture_answering(FixtureState {
        status,
        ..FixtureState::default()
    })
    .await
}

pub(crate) async fn fixture_answering(mut state: FixtureState) -> Fixture {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind fixture");
    let address = listener.local_addr().expect("fixture address");
    if state.redirect {
        state.location = Some(format!("http://{address}/redirected"));
    }
    let state = Arc::new(std::sync::Mutex::new(state));
    let task = tokio::spawn({
        let state = state.clone();
        async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(handle_connection(stream, state.clone()));
            }
        }
    });
    Fixture {
        endpoint: format!("http://{address}"),
        state,
        task,
    }
}
