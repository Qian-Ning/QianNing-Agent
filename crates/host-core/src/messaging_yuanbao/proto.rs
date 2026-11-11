//! Wire format for Tencent Yuanbao's bot relay.
//!
//! One WebSocket frame carries one `ConnMsg`. The connection layer is plain
//! protobuf, but it is not self-describing: `Head.cmd` names the command and
//! `ConnMsg.data` holds a payload whose type is implied by that command, so the
//! structures below are named after the commands that carry them.
//!
//! These are declared with `prost` derive attributes rather than generated from
//! `.proto` files: generating at build time would make `protoc` a build
//! requirement for every target, including the ones that never open a socket.

use prost::Message;

/// Connection-layer message type, carried in `Head.cmd_type`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CmdType {
    Request = 0,
    Response = 1,
    Push = 2,
    PushAck = 3,
}

impl CmdType {
    pub fn from_i32(value: i32) -> Option<Self> {
        match value {
            0 => Some(Self::Request),
            1 => Some(Self::Response),
            2 => Some(Self::Push),
            3 => Some(Self::PushAck),
            _ => None,
        }
    }
}

/// `trpc.yuanbao.conn_common.Head`.
#[derive(Clone, PartialEq, Message)]
pub struct Head {
    #[prost(int32, tag = "1")]
    pub cmd_type: i32,
    #[prost(string, tag = "2")]
    pub cmd: String,
    #[prost(uint32, tag = "3")]
    pub seq_no: u32,
    #[prost(string, tag = "4")]
    pub msg_id: String,
    #[prost(string, tag = "5")]
    pub module: String,
    #[prost(bool, tag = "6")]
    pub need_ack: bool,
    #[prost(uint64, tag = "10")]
    pub status: u64,
}

/// `trpc.yuanbao.conn_common.ConnMsg` — one WebSocket frame.
#[derive(Clone, PartialEq, Message)]
pub struct ConnMsg {
    #[prost(message, optional, tag = "1")]
    pub head: Option<Head>,
    #[prost(bytes = "vec", tag = "2")]
    pub data: Vec<u8>,
}

/// One element of a message body. A text message is `TIMTextElem`.
#[derive(Clone, PartialEq, Message)]
pub struct MsgBodyElement {
    #[prost(string, tag = "1")]
    pub msg_type: String,
    #[prost(message, optional, tag = "2")]
    pub msg_content: Option<MsgContent>,
}

#[derive(Clone, PartialEq, Message)]
pub struct MsgContent {
    #[prost(string, tag = "1")]
    pub text: String,
}

/// Trace identifier attached to every send and to every inbound push.
#[derive(Clone, PartialEq, Message)]
pub struct LogInfoExt {
    #[prost(string, tag = "1")]
    pub trace_id: String,
}

/// `trpc.yuanbao.conn_common.AuthBindReq`.
#[derive(Clone, PartialEq, Message)]
pub struct AuthBindReq {
    #[prost(string, tag = "1")]
    pub biz_id: String,
    #[prost(message, optional, tag = "2")]
    pub auth_info: Option<AuthInfo>,
    #[prost(message, optional, tag = "3")]
    pub device_info: Option<DeviceInfo>,
    #[prost(string, tag = "5")]
    pub env_name: String,
}

#[derive(Clone, PartialEq, Message)]
pub struct AuthInfo {
    #[prost(string, tag = "1")]
    pub uid: String,
    #[prost(string, tag = "2")]
    pub source: String,
    #[prost(string, tag = "3")]
    pub token: String,
}

#[derive(Clone, PartialEq, Message)]
pub struct DeviceInfo {
    #[prost(string, tag = "1")]
    pub app_version: String,
    #[prost(string, tag = "2")]
    pub app_operation_system: String,
    #[prost(string, tag = "10")]
    pub instance_id: String,
    #[prost(string, tag = "24")]
    pub bot_version: String,
}

/// One-to-one send.
#[derive(Clone, PartialEq, Message)]
pub struct SendC2CMessageReq {
    #[prost(string, tag = "1")]
    pub msg_id: String,
    #[prost(string, tag = "2")]
    pub to_account: String,
    #[prost(string, tag = "3")]
    pub from_account: String,
    #[prost(uint32, tag = "4")]
    pub msg_random: u32,
    #[prost(message, repeated, tag = "5")]
    pub msg_body: Vec<MsgBodyElement>,
    #[prost(string, tag = "6")]
    pub group_code: String,
    #[prost(uint64, tag = "7")]
    pub msg_seq: u64,
    #[prost(message, optional, tag = "8")]
    pub log_ext: Option<LogInfoExt>,
}

/// Group send.
#[derive(Clone, PartialEq, Message)]
pub struct SendGroupMessageReq {
    #[prost(string, tag = "1")]
    pub msg_id: String,
    #[prost(string, tag = "2")]
    pub group_code: String,
    #[prost(string, tag = "3")]
    pub from_account: String,
    #[prost(string, tag = "4")]
    pub to_account: String,
    #[prost(string, tag = "5")]
    pub random: String,
    #[prost(message, repeated, tag = "6")]
    pub msg_body: Vec<MsgBodyElement>,
    #[prost(string, tag = "7")]
    pub ref_msg_id: String,
    #[prost(uint64, tag = "8")]
    pub msg_seq: u64,
    #[prost(message, optional, tag = "9")]
    pub log_ext: Option<LogInfoExt>,
}

/// Pairing of sequence and id, used by the recall list.
#[derive(Clone, PartialEq, Message)]
pub struct ImMsgSeq {
    #[prost(uint64, tag = "1")]
    pub msg_seq: u64,
    #[prost(string, tag = "2")]
    pub msg_id: String,
}

/// A message arriving from the relay.
#[derive(Clone, PartialEq, Message)]
pub struct InboundMessagePush {
    #[prost(string, tag = "1")]
    pub callback_command: String,
    #[prost(string, tag = "2")]
    pub from_account: String,
    #[prost(string, tag = "3")]
    pub to_account: String,
    #[prost(string, tag = "4")]
    pub sender_nickname: String,
    #[prost(string, tag = "5")]
    pub group_id: String,
    #[prost(string, tag = "6")]
    pub group_code: String,
    #[prost(string, tag = "7")]
    pub group_name: String,
    #[prost(uint64, tag = "8")]
    pub msg_seq: u64,
    #[prost(uint64, tag = "9")]
    pub msg_random: u64,
    #[prost(uint64, tag = "10")]
    pub msg_time: u64,
    #[prost(string, tag = "11")]
    pub msg_key: String,
    #[prost(string, tag = "12")]
    pub msg_id: String,
    #[prost(message, repeated, tag = "13")]
    pub msg_body: Vec<MsgBodyElement>,
    #[prost(string, tag = "14")]
    pub cloud_custom_data: String,
    #[prost(uint64, tag = "15")]
    pub event_time: u64,
    #[prost(string, tag = "16")]
    pub bot_owner_id: String,
    #[prost(message, repeated, tag = "17")]
    pub recall_msg_seq_list: Vec<ImMsgSeq>,
    #[prost(uint64, tag = "18")]
    pub claw_msg_type: u64,
    #[prost(string, tag = "19")]
    pub private_from_group_code: String,
    #[prost(message, optional, tag = "20")]
    pub log_ext: Option<LogInfoExt>,
}

/// Heartbeat for a one-to-one conversation; `1` means running, `2` finished.
#[derive(Clone, PartialEq, Message)]
pub struct SendPrivateHeartbeatReq {
    #[prost(string, tag = "1")]
    pub from_account: String,
    #[prost(string, tag = "2")]
    pub to_account: String,
    #[prost(uint32, tag = "3")]
    pub heartbeat: u32,
}

/// The first `msg_type` this build sends.
pub const TEXT_ELEMENT: &str = "TIMTextElem";

pub fn text_body(text: &str) -> MsgBodyElement {
    MsgBodyElement {
        msg_type: TEXT_ELEMENT.to_string(),
        msg_content: Some(MsgContent {
            text: text.to_string(),
        }),
    }
}

/// The text of the first text element, if the push carries one.
pub fn text_of(body: &[MsgBodyElement]) -> Option<&str> {
    body.iter()
        .find(|el| el.msg_type == TEXT_ELEMENT)
        .and_then(|el| el.msg_content.as_ref())
        .map(|content| content.text.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_conn_msg_round_trips_through_its_wire_bytes() {
        let msg = ConnMsg {
            head: Some(Head {
                cmd_type: CmdType::Request as i32,
                cmd: "send_c2c_message".into(),
                seq_no: 7,
                msg_id: "m-1".into(),
                module: "conn_access".into(),
                need_ack: false,
                status: 0,
            }),
            data: b"payload".to_vec(),
        };
        let bytes = msg.encode_to_vec();
        let back = ConnMsg::decode(bytes.as_slice()).expect("decode");
        assert_eq!(back, msg);
    }

    #[test]
    fn an_auth_bind_request_carries_its_credentials_in_their_own_fields() {
        let req = AuthBindReq {
            biz_id: "biz".into(),
            auth_info: Some(AuthInfo {
                uid: "uid".into(),
                source: "source".into(),
                token: "secret-token".into(),
            }),
            device_info: Some(DeviceInfo {
                instance_id: "17".into(),
                ..Default::default()
            }),
            env_name: "prod".into(),
        };
        let bytes = req.encode_to_vec();
        let back = AuthBindReq::decode(bytes.as_slice()).expect("decode");
        assert_eq!(
            back.auth_info.as_ref().map(|a| a.token.as_str()),
            Some("secret-token")
        );
        assert_eq!(
            back.device_info.as_ref().map(|d| d.instance_id.as_str()),
            Some("17")
        );
    }

    #[test]
    fn a_text_send_encodes_the_element_the_relay_expects() {
        let req = SendC2CMessageReq {
            msg_id: "m-2".into(),
            to_account: "peer".into(),
            from_account: "bot".into(),
            msg_body: vec![text_body("hello 你好")],
            log_ext: Some(LogInfoExt {
                trace_id: "t-1".into(),
            }),
            ..Default::default()
        };
        let back = SendC2CMessageReq::decode(req.encode_to_vec().as_slice()).expect("decode");
        assert_eq!(text_of(&back.msg_body), Some("hello 你好"));
        assert_eq!(back.log_ext.map(|l| l.trace_id), Some("t-1".into()));
    }

    #[test]
    fn an_inbound_push_keeps_its_body_trace_and_recall_list() {
        let push = InboundMessagePush {
            from_account: "peer".into(),
            to_account: "bot".into(),
            sender_nickname: "千凝".into(),
            group_code: String::new(),
            msg_seq: 3,
            msg_time: 1_794_351_128_000,
            msg_id: "m-3".into(),
            msg_body: vec![text_body("hi")],
            recall_msg_seq_list: vec![ImMsgSeq {
                msg_seq: 1,
                msg_id: "m-1".into(),
            }],
            log_ext: Some(LogInfoExt {
                trace_id: "t-3".into(),
            }),
            ..Default::default()
        };
        let back = InboundMessagePush::decode(push.encode_to_vec().as_slice()).expect("decode");
        assert_eq!(text_of(&back.msg_body), Some("hi"));
        assert_eq!(back.recall_msg_seq_list.len(), 1);
        assert_eq!(
            back.log_ext.as_ref().map(|l| l.trace_id.as_str()),
            Some("t-3")
        );
    }

    #[test]
    fn a_group_push_is_distinguished_by_its_group_code() {
        let push = InboundMessagePush {
            from_account: "peer".into(),
            group_code: "group-9".into(),
            msg_body: vec![text_body("in group")],
            ..Default::default()
        };
        let back = InboundMessagePush::decode(push.encode_to_vec().as_slice()).expect("decode");
        assert!(!back.group_code.is_empty());
    }

    #[test]
    fn an_unknown_cmd_type_is_not_silently_mapped() {
        assert_eq!(CmdType::from_i32(9), None);
        assert_eq!(CmdType::from_i32(2), Some(CmdType::Push));
    }
}
