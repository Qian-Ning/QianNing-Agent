use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use prost::Message as _;
use tokio_tungstenite::tungstenite::Message;

use super::*;
use crate::messaging_yuanbao::proto::{text_body, CmdType, ConnMsg, Head, InboundMessagePush};
use crate::messaging_yuanbao::session::SessionConfig;

fn conn(cmd_type: CmdType, cmd: &str, data: Vec<u8>) -> Vec<u8> {
    ConnMsg {
        head: Some(Head {
            cmd_type: cmd_type as i32,
            cmd: cmd.into(),
            ..Default::default()
        }),
        data,
    }
    .encode_to_vec()
}

/// A relay that answers the handshake, pushes one message, then waits for the
/// acknowledgement before closing.
async fn serve_one_push(listener: tokio::net::TcpListener, accept_auth: bool) {
    let (stream, _) = listener.accept().await.expect("accept");
    let mut ws = tokio_tungstenite::accept_async(stream)
        .await
        .expect("handshake");

    // The client authenticates first.
    let first = ws.next().await.expect("frame").expect("frame ok");
    let Message::Binary(bytes) = first else {
        panic!("expected a binary auth frame");
    };
    let auth = ConnMsg::decode(bytes.as_slice()).expect("auth conn msg");
    assert_eq!(auth.head.as_ref().unwrap().cmd, "auth-bind");

    let status = if accept_auth { 0 } else { 401 };
    let rsp = ConnMsg {
        head: Some(Head {
            cmd_type: CmdType::Response as i32,
            cmd: "auth-bind".into(),
            status,
            ..Default::default()
        }),
        data: Vec::new(),
    };
    ws.send(Message::Binary(rsp.encode_to_vec()))
        .await
        .expect("auth response");

    if !accept_auth {
        let _ = ws.close(None).await;
        return;
    }

    let push = InboundMessagePush {
        from_account: "peer".into(),
        sender_nickname: "千凝".into(),
        msg_id: "m-1".into(),
        msg_time: 1_794_351_128_000,
        msg_body: vec![text_body("你好")],
        ..Default::default()
    };
    ws.send(Message::Binary(conn(
        CmdType::Push,
        "inbound_message",
        push.encode_to_vec(),
    )))
    .await
    .expect("push");

    // The client must acknowledge before the socket is closed.
    let ack = ws.next().await.expect("ack").expect("ack ok");
    let Message::Binary(bytes) = ack else {
        panic!("expected a binary ack");
    };
    let ack = ConnMsg::decode(bytes.as_slice()).expect("ack conn msg");
    assert_eq!(ack.head.as_ref().unwrap().cmd_type, CmdType::PushAck as i32);
    assert_eq!(ack.head.as_ref().unwrap().cmd, "inbound_message");
}

#[tokio::test]
async fn a_connection_authenticates_then_delivers_what_the_relay_pushes() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    let server = tokio::spawn(serve_one_push(listener, true));

    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    let mut session = Session::new(SessionConfig::new("app", "secret", "bot-account"));
    let mut emit = move |event: ConnectionEvent| {
        let _ = tx.try_send(match event {
            ConnectionEvent::Ready => "ready".to_string(),
            ConnectionEvent::Message(m) => format!("message:{}:{}", m.conversation, m.text),
            ConnectionEvent::SendResult { msg_id, status } => format!("result:{msg_id}:{status}"),
        });
    };

    let url = format!("ws://{addr}");
    let run = tokio::time::timeout(
        Duration::from_secs(10),
        run(
            &url,
            std::mem::replace(
                &mut session,
                Session::new(SessionConfig::new("a", "b", "c")),
            ),
            &mut emit,
        ),
    )
    .await;

    // The server closes after the ack, so the loop ends with a closed connection.
    assert!(run.is_ok(), "the loop should have ended on its own");
    let mut seen = Vec::new();
    while let Ok(event) = rx.try_recv() {
        seen.push(event);
    }
    assert_eq!(
        seen,
        vec!["ready".to_string(), "message:peer:你好".to_string()]
    );
    server.await.expect("server");
}

#[tokio::test]
async fn a_refused_handshake_never_reports_ready() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    let server = tokio::spawn(serve_one_push(listener, false));

    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    let mut emit = move |event: ConnectionEvent| {
        if matches!(event, ConnectionEvent::Ready) {
            let _ = tx.try_send("ready");
        }
    };

    let url = format!("ws://{addr}");
    let outcome = tokio::time::timeout(
        Duration::from_secs(10),
        run(
            &url,
            Session::new(SessionConfig::new("app", "secret", "bot")),
            &mut emit,
        ),
    )
    .await;

    assert!(
        outcome.expect("finished").is_err(),
        "a closed socket is an error"
    );
    assert!(
        rx.try_recv().is_err(),
        "nothing should have been reported ready"
    );
    server.await.expect("server");
}
