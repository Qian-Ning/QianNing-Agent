//! The state machine between a socket and a turn.
//!
//! A frame arrives, this decides what to answer and whether a person said
//! something. No I/O lives here, so the handshake, the ack discipline and the
//! echo rule are all exercised by tests without a relay.

use super::proto::{
    text_body, AuthBindReq, AuthInfo, CmdType, ConnMsg, DeviceInfo, Head, InboundMessagePush,
    SendC2CMessageReq, SendGroupMessageReq, TEXT_ELEMENT,
};

/// Where an outgoing message goes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
    /// A one-to-one conversation, addressed by the peer's account.
    Direct(String),
    /// A group, addressed by its code.
    Group(String),
}

impl Target {
    pub fn conversation(&self) -> &str {
        match self {
            Target::Direct(peer) => peer,
            Target::Group(code) => code,
        }
    }
}

/// A message a person sent, in the shape a turn needs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InboundMessage {
    pub id: String,
    pub conversation: String,
    pub sender: String,
    pub sender_name: String,
    pub text: String,
    /// Milliseconds since the epoch, as the relay reports it.
    pub sent_at: u64,
    pub in_group: bool,
}

/// What the socket loop should do after handing a frame over.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Step {
    /// A frame to write back, if the relay expects one.
    pub reply: Option<Vec<u8>>,
    /// Messages worth starting a turn for.
    pub messages: Vec<InboundMessage>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionError {
    /// The frame was not a `ConnMsg`.
    MalformedFrame,
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionError::MalformedFrame => write!(f, "frame is not a ConnMsg"),
        }
    }
}

impl std::error::Error for SessionError {}

/// How this build identifies itself to the relay.
#[derive(Clone, Debug)]
pub struct SessionConfig {
    pub app_id: String,
    pub app_secret: String,
    /// The bot's own account. Used to drop our own messages coming back.
    pub account: String,
    pub instance_id: String,
    pub env_name: String,
}

impl SessionConfig {
    /// The instance id a standalone bot reports; the reference client uses the
    /// same value for its own generic deployment.
    pub const DEFAULT_INSTANCE: &'static str = "17";

    pub fn new(
        app_id: impl Into<String>,
        app_secret: impl Into<String>,
        account: impl Into<String>,
    ) -> Self {
        Self {
            app_id: app_id.into(),
            app_secret: app_secret.into(),
            account: account.into(),
            instance_id: Self::DEFAULT_INSTANCE.to_string(),
            env_name: String::new(),
        }
    }
}

pub struct Session {
    config: SessionConfig,
    seq: u32,
    authenticated: bool,
}

impl Session {
    pub fn new(config: SessionConfig) -> Self {
        Self {
            config,
            seq: 0,
            authenticated: false,
        }
    }

    pub fn is_authenticated(&self) -> bool {
        self.authenticated
    }

    /// The bot's own account, as configured.
    pub fn account(&self) -> &str {
        &self.config.account
    }

    fn next(seq: &mut u32) -> u32 {
        *seq = seq.wrapping_add(1).max(1);
        *seq
    }

    fn frame(head: Head, data: Vec<u8>) -> Vec<u8> {
        let mut msg = ConnMsg {
            head: Some(head),
            data,
        };
        let _ = &mut msg;
        use prost::Message;
        msg.encode_to_vec()
    }

    /// The `auth-bind` request that opens a connection.
    pub fn auth_frame(&mut self) -> Vec<u8> {
        let req = AuthBindReq {
            biz_id: self.config.app_id.clone(),
            auth_info: Some(AuthInfo {
                uid: self.config.account.clone(),
                source: String::new(),
                token: self.config.app_secret.clone(),
            }),
            device_info: Some(DeviceInfo {
                instance_id: self.config.instance_id.clone(),
                ..Default::default()
            }),
            env_name: self.config.env_name.clone(),
        };
        use prost::Message;
        let seq = Self::next(&mut self.seq);
        Self::frame(
            Head {
                cmd_type: CmdType::Request as i32,
                cmd: "auth-bind".into(),
                seq_no: seq,
                module: "conn_access".into(),
                ..Default::default()
            },
            req.encode_to_vec(),
        )
    }

    /// The keep-alive frame. `PingReq` is empty.
    pub fn ping_frame(&mut self) -> Vec<u8> {
        let seq = Self::next(&mut self.seq);
        Self::frame(
            Head {
                cmd_type: CmdType::Request as i32,
                cmd: "ping".into(),
                seq_no: seq,
                module: "conn_access".into(),
                ..Default::default()
            },
            Vec::new(),
        )
    }

    /// One text message. `msg_id` doubles as the request id.
    pub fn text_frame(&mut self, target: &Target, msg_id: &str, text: &str) -> Vec<u8> {
        let body = vec![text_body(text)];
        let seq = Self::next(&mut self.seq);
        match target {
            Target::Direct(peer) => {
                let req = SendC2CMessageReq {
                    msg_id: msg_id.to_string(),
                    to_account: peer.clone(),
                    from_account: self.config.account.clone(),
                    msg_body: body,
                    ..Default::default()
                };
                use prost::Message;
                Self::frame(
                    Head {
                        cmd_type: CmdType::Request as i32,
                        cmd: "send_c2c_message".into(),
                        seq_no: seq,
                        msg_id: msg_id.to_string(),
                        ..Default::default()
                    },
                    req.encode_to_vec(),
                )
            }
            Target::Group(code) => {
                let req = SendGroupMessageReq {
                    msg_id: msg_id.to_string(),
                    group_code: code.clone(),
                    from_account: self.config.account.clone(),
                    msg_body: body,
                    ..Default::default()
                };
                use prost::Message;
                Self::frame(
                    Head {
                        cmd_type: CmdType::Request as i32,
                        cmd: "send_group_message".into(),
                        seq_no: seq,
                        msg_id: msg_id.to_string(),
                        ..Default::default()
                    },
                    req.encode_to_vec(),
                )
            }
        }
    }

    /// Hand one frame from the relay to the machine.
    pub fn on_frame(&mut self, bytes: &[u8]) -> Result<Step, SessionError> {
        use prost::Message;
        let msg = ConnMsg::decode(bytes).map_err(|_| SessionError::MalformedFrame)?;
        let head = msg.head.unwrap_or_default();
        let Some(kind) = CmdType::from_i32(head.cmd_type) else {
            return Ok(Step::default());
        };

        match kind {
            CmdType::Response => {
                // A successful `auth-bind` response is what makes the session
                // usable; the relay reports failure in `status`.
                if head.cmd == "auth-bind" && head.status == 0 {
                    self.authenticated = true;
                }
                Ok(Step::default())
            }
            CmdType::Push => {
                let ack = Self::ack_for(&head);
                let push = InboundMessagePush::decode(msg.data.as_slice()).ok();
                let messages = push
                    .as_ref()
                    .filter(|p| self.accepts(p))
                    .map(|p| vec![Self::project(p)])
                    .unwrap_or_default();
                Ok(Step {
                    reply: Some(ack),
                    messages,
                })
            }
            CmdType::PushAck | CmdType::Request => Ok(Step::default()),
        }
    }

    /// The relay expects a `PushAck` echoing the command, id and module.
    fn ack_for(head: &Head) -> Vec<u8> {
        let mut seq = head.seq_no;
        Self::frame(
            Head {
                cmd_type: CmdType::PushAck as i32,
                cmd: head.cmd.clone(),
                seq_no: Self::next(&mut seq),
                msg_id: head.msg_id.clone(),
                module: head.module.clone(),
                ..Default::default()
            },
            Vec::new(),
        )
    }

    /// Our own messages come back on the same stream; there is no flag for it,
    /// so the sender account is the whole test.
    fn accepts(&self, push: &InboundMessagePush) -> bool {
        !push.from_account.is_empty()
            && push.from_account != self.config.account
            && !push.msg_id.is_empty()
            && push
                .msg_body
                .iter()
                .any(|el| el.msg_type == TEXT_ELEMENT && !text_of_single(el).is_empty())
    }

    fn project(push: &InboundMessagePush) -> InboundMessage {
        let in_group = !push.group_code.is_empty();
        InboundMessage {
            id: push.msg_id.clone(),
            conversation: if in_group {
                push.group_code.clone()
            } else {
                push.from_account.clone()
            },
            sender: push.from_account.clone(),
            sender_name: if push.sender_nickname.is_empty() {
                push.from_account.clone()
            } else {
                push.sender_nickname.clone()
            },
            text: super::proto::text_of(&push.msg_body)
                .unwrap_or_default()
                .to_string(),
            sent_at: push.msg_time,
            in_group,
        }
    }
}

fn text_of_single(el: &super::proto::MsgBodyElement) -> String {
    el.msg_content
        .as_ref()
        .map(|c| c.text.clone())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use prost::Message;

    fn session() -> Session {
        Session::new(SessionConfig::new("app", "secret", "bot-account"))
    }

    fn decode(bytes: &[u8]) -> ConnMsg {
        ConnMsg::decode(bytes).expect("conn msg")
    }

    #[test]
    fn the_handshake_announces_the_credentials_and_the_instance() {
        let mut s = session();
        let frame = decode(&s.auth_frame());
        let head = frame.head.expect("head");
        assert_eq!(head.cmd, "auth-bind");
        assert_eq!(head.cmd_type, CmdType::Request as i32);
        assert_eq!(head.module, "conn_access");
        let req = AuthBindReq::decode(frame.data.as_slice()).expect("auth req");
        assert_eq!(req.biz_id, "app");
        assert_eq!(req.auth_info.as_ref().unwrap().token, "secret");
        assert_eq!(req.device_info.as_ref().unwrap().instance_id, "17");
    }

    #[test]
    fn a_successful_auth_response_makes_the_session_usable() {
        let mut s = session();
        assert!(!s.is_authenticated());
        let rsp = ConnMsg {
            head: Some(Head {
                cmd_type: CmdType::Response as i32,
                cmd: "auth-bind".into(),
                seq_no: 1,
                ..Default::default()
            }),
            data: Vec::new(),
        };
        s.on_frame(&rsp.encode_to_vec()).expect("frame");
        assert!(s.is_authenticated());
    }

    #[test]
    fn a_failed_auth_response_does_not() {
        let mut s = session();
        let rsp = ConnMsg {
            head: Some(Head {
                cmd_type: CmdType::Response as i32,
                cmd: "auth-bind".into(),
                status: 401,
                ..Default::default()
            }),
            data: Vec::new(),
        };
        s.on_frame(&rsp.encode_to_vec()).expect("frame");
        assert!(!s.is_authenticated());
    }

    #[test]
    fn a_push_is_acknowledged_and_becomes_a_message() {
        let mut s = session();
        let push = InboundMessagePush {
            from_account: "peer".into(),
            sender_nickname: "千凝".into(),
            msg_id: "m-1".into(),
            msg_time: 1_794_351_128_000,
            msg_body: vec![text_body("你好")],
            ..Default::default()
        };
        let frame = ConnMsg {
            head: Some(Head {
                cmd_type: CmdType::Push as i32,
                cmd: "inbound_message".into(),
                seq_no: 4,
                msg_id: "m-1".into(),
                need_ack: true,
                ..Default::default()
            }),
            data: push.encode_to_vec(),
        };
        let step = s.on_frame(&frame.encode_to_vec()).expect("frame");
        let ack = decode(step.reply.as_ref().expect("ack"));
        assert_eq!(ack.head.as_ref().unwrap().cmd_type, CmdType::PushAck as i32);
        assert_eq!(ack.head.as_ref().unwrap().cmd, "inbound_message");
        assert_eq!(step.messages.len(), 1);
        assert_eq!(step.messages[0].text, "你好");
        assert_eq!(step.messages[0].conversation, "peer");
        assert_eq!(step.messages[0].sender_name, "千凝");
        assert!(!step.messages[0].in_group);
    }

    #[test]
    fn our_own_message_coming_back_is_acknowledged_but_not_delivered() {
        let mut s = session();
        let push = InboundMessagePush {
            from_account: "bot-account".into(),
            msg_id: "m-2".into(),
            msg_body: vec![text_body("echo")],
            ..Default::default()
        };
        let frame = ConnMsg {
            head: Some(Head {
                cmd_type: CmdType::Push as i32,
                cmd: "inbound_message".into(),
                ..Default::default()
            }),
            data: push.encode_to_vec(),
        };
        let step = s.on_frame(&frame.encode_to_vec()).expect("frame");
        assert!(step.reply.is_some(), "the relay still wants its ack");
        assert!(step.messages.is_empty(), "but it is not a new turn");
    }

    #[test]
    fn a_group_push_keeps_the_group_as_the_conversation() {
        let mut s = session();
        let push = InboundMessagePush {
            from_account: "peer".into(),
            group_code: "group-9".into(),
            msg_id: "m-3".into(),
            msg_body: vec![text_body("in group")],
            ..Default::default()
        };
        let frame = ConnMsg {
            head: Some(Head {
                cmd_type: CmdType::Push as i32,
                ..Default::default()
            }),
            data: push.encode_to_vec(),
        };
        let step = s.on_frame(&frame.encode_to_vec()).expect("frame");
        assert!(step.messages[0].in_group);
        assert_eq!(step.messages[0].conversation, "group-9");
    }

    #[test]
    fn a_message_without_text_is_acknowledged_and_ignored() {
        let mut s = session();
        let push = InboundMessagePush {
            from_account: "peer".into(),
            msg_id: "m-4".into(),
            msg_body: Vec::new(),
            ..Default::default()
        };
        let frame = ConnMsg {
            head: Some(Head {
                cmd_type: CmdType::Push as i32,
                ..Default::default()
            }),
            data: push.encode_to_vec(),
        };
        let step = s.on_frame(&frame.encode_to_vec()).expect("frame");
        assert!(step.messages.is_empty());
    }

    #[test]
    fn a_direct_send_names_the_peer_and_carries_the_text() {
        let mut s = session();
        let frame = decode(&s.text_frame(&Target::Direct("peer".into()), "m-5", "hi"));
        let head = frame.head.expect("head");
        assert_eq!(head.cmd, "send_c2c_message");
        assert_eq!(head.msg_id, "m-5");
        let req = SendC2CMessageReq::decode(frame.data.as_slice()).expect("req");
        assert_eq!(req.to_account, "peer");
        assert_eq!(req.from_account, "bot-account");
        assert_eq!(super::super::proto::text_of(&req.msg_body), Some("hi"));
    }

    #[test]
    fn a_group_send_names_the_group() {
        let mut s = session();
        let frame = decode(&s.text_frame(&Target::Group("group-9".into()), "m-6", "hi"));
        let head = frame.head.expect("head");
        assert_eq!(head.cmd, "send_group_message");
        let req = SendGroupMessageReq::decode(frame.data.as_slice()).expect("req");
        assert_eq!(req.group_code, "group-9");
    }

    #[test]
    fn a_frame_that_is_not_a_conn_msg_is_reported_rather_than_guessed() {
        let mut s = session();
        assert_eq!(
            s.on_frame(&[0xff, 0xff, 0xff]),
            Err(SessionError::MalformedFrame)
        );
    }
}
