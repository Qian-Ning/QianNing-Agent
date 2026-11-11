use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use prost::Message as _;
use tokio_tungstenite::tungstenite::Message;

use super::*;
use crate::messaging_yuanbao::proto::{text_body, CmdType, ConnMsg, Head, InboundMessagePush};

fn frame(head: Head, data: Vec<u8>) -> Vec<u8> {
    ConnMsg {
        head: Some(head),
        data,
    }
    .encode_to_vec()
}

/// Serve one connection: accept the handshake, push one message, close.
async fn serve_once(listener: tokio::net::TcpListener) {
    let (stream, _) = listener.accept().await.expect("accept");
    let mut ws = tokio_tungstenite::accept_async(stream)
        .await
        .expect("handshake");
    let _ = ws.next().await; // auth
    ws.send(Message::Binary(frame(
        Head {
            cmd_type: CmdType::Response as i32,
            cmd: "auth-bind".into(),
            ..Default::default()
        },
        Vec::new(),
    )))
    .await
    .expect("auth ok");

    ws.send(Message::Binary(frame(
        Head {
            cmd_type: CmdType::Push as i32,
            cmd: "inbound_message".into(),
            ..Default::default()
        },
        InboundMessagePush {
            from_account: "peer".into(),
            msg_id: "m-1".into(),
            msg_body: vec![text_body("来自服务层")],
            ..Default::default()
        }
        .encode_to_vec(),
    )))
    .await
    .expect("push");

    // Wait for the ack so the client is not torn down mid-write.
    let _ = ws.next().await;
    let _ = ws.close(None).await;
}

#[tokio::test]
async fn a_started_channel_delivers_what_the_relay_pushes() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    let server = tokio::spawn(serve_once(listener));

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let running = start(
        ChannelConfig {
            url: format!("ws://{addr}"),
            app_id: "app".into(),
            app_secret: "secret".into(),
            account: "bot".into(),
        },
        tx,
    );

    let message = tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .expect("a message within the timeout")
        .expect("a message");
    assert_eq!(message.text, "来自服务层");
    assert_eq!(message.conversation, "peer");

    running.stop();
    server.await.expect("server");
}

#[tokio::test]
async fn stopping_ends_the_loop_without_waiting_for_a_connection() {
    // Nothing is listening on this port, so the dial keeps failing and retrying.
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let running = start(
        ChannelConfig {
            url: "ws://127.0.0.1:1".into(),
            app_id: "app".into(),
            app_secret: "secret".into(),
            account: "bot".into(),
        },
        tx,
    );
    running.stop();
    let joined = tokio::time::timeout(Duration::from_secs(30), running.join()).await;
    assert!(joined.is_ok(), "stop should end the loop");
}
