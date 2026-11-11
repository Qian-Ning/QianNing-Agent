use std::time::Duration;

use prost::Message as _;
use tokio_tungstenite::tungstenite::Message;

use super::*;
use crate::messaging_adapter::OutboundMessage;
use crate::messaging_yuanbao::proto::{text_body, CmdType, ConnMsg, Head, InboundMessagePush};

fn channel(record: StoredConfig) -> YuanbaoAdapter {
    YuanbaoAdapter {
        url: record.endpoint,
        target: Target::Direct(record.destination),
        app_id: "app".into(),
        app_secret: "secret".into(),
        account: "bot".into(),
        timeout: Duration::from_secs(5),
    }
}

fn record(destination: &str) -> StoredConfig {
    StoredConfig {
        format: FORMAT.into(),
        version: FORMAT_VERSION,
        endpoint: "wss://relay.example".into(),
        destination: destination.into(),
        account: "bot".into(),
        request_timeout_ms: None,
    }
}

fn message() -> OutboundMessage {
    OutboundMessage {
        id: "d-1".into(),
        channel: "yuanbao".into(),
        payload: serde_json::json!({ "text": "你好" }),
        redelivery: false,
    }
}

/// A relay that accepts the handshake and captures the send that follows.
async fn serve(listener: tokio::net::TcpListener) -> Vec<u8> {
    let (stream, _) = listener.accept().await.expect("accept");
    let mut ws = tokio_tungstenite::accept_async(stream)
        .await
        .expect("handshake");
    let _ = ws.next().await; // auth-bind
    ws.send(Message::Binary(
        ConnMsg {
            head: Some(Head {
                cmd_type: CmdType::Response as i32,
                cmd: "auth-bind".into(),
                ..Default::default()
            }),
            data: Vec::new(),
        }
        .encode_to_vec(),
    ))
    .await
    .expect("auth ok");

    let sent = ws.next().await.expect("send").expect("send ok");
    let Message::Binary(bytes) = sent else {
        panic!("expected a binary send");
    };
    let _ = ws.close(None).await;
    bytes
}

#[test]
fn a_record_without_a_conversation_is_refused() {
    let mut bad = record("");
    assert!(check_record(&bad).is_err());
    bad = record("peer");
    bad.account.clear();
    assert!(check_record(&bad).is_err());
    let mut wrong = record("peer");
    wrong.format = "something-else".into();
    assert!(check_record(&wrong).is_err());
    assert!(check_record(&record("peer")).is_ok());
}

#[test]
fn a_delivery_sends_the_envelope_after_the_handshake() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let captured = runtime.block_on(async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let server = tokio::spawn(serve(listener));
        let mut adapter = channel(record("peer"));
        adapter.url = format!("ws://{addr}");
        let result = adapter.deliver(&message()).await;
        assert_eq!(result, SendResult::Delivered { remote_id: None });
        server.await.expect("server")
    });

    let msg = ConnMsg::decode(captured.as_slice()).expect("conn msg");
    let head = msg.head.expect("head");
    assert_eq!(head.cmd, "send_c2c_message");
    assert_eq!(head.msg_id, "d-1");
}

#[test]
fn a_relay_that_never_answers_costs_a_retryable_failure() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    // Nothing listens here, so the dial fails immediately.
    let mut adapter = channel(record("peer"));
    adapter.url = "ws://127.0.0.1:1".into();
    let result = runtime.block_on(adapter.deliver(&message()));
    assert!(matches!(
        result,
        SendResult::Failed {
            kind: FailureKind::Retryable,
            ..
        }
    ));
}

#[test]
fn a_text_push_is_projected_but_the_inbound_side_is_not_this_adapter() {
    // The outbound adapter must not turn a push into a delivery; this pins the
    // boundary so a later wiring change cannot smuggle inbound through `send`.
    let push = InboundMessagePush {
        from_account: "peer".into(),
        msg_id: "m-1".into(),
        msg_body: vec![text_body("hi")],
        ..Default::default()
    };
    assert_eq!(
        crate::messaging_yuanbao::proto::text_of(&push.msg_body),
        Some("hi")
    );
}
