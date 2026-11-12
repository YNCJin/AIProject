from streamdirector.collectors.chzzk import ChzzkAuth, ChzzkCollector, socket_ws_url
from streamdirector.collectors.discord_bot import describe_donation_result, parse_donation_text


def test_discord_donation_parse():
    assert parse_donation_text("/후원 1000 보스 소환해줘") == (1000, "보스 소환해줘")
    assert parse_donation_text("/후원 10,000 힐") == (10000, "힐")
    assert parse_donation_text("/후원 1000") == (1000, "")
    assert parse_donation_text("후원 1000 x") is None
    assert "가중치" in describe_donation_result(1000, {"mode": "vote", "weight": 2.0})


def test_chzzk_ws_url():
    assert socket_ws_url("https://ssio08.nchat.naver.com:443?auth=AB") == \
        "wss://ssio08.nchat.naver.com:443/socket.io/?auth=AB&EIO=3&transport=websocket"


async def test_chzzk_event_mapping(tmp_path):
    chats, dons = [], []
    c = ChzzkCollector(ChzzkAuth("id", "secret", "", token_file=tmp_path / "t.json"), chats.append, dons.append,
                       use_client_session=True)
    await c._handle("SYSTEM", {"type": "connected", "data": {"sessionKey": "k"}})
    await c._handle("CHAT", {"senderChannelId": "ch1", "profile": {"nickname": "n"}, "content": "보스 소환",
                             "messageTime": 1700000000000})
    await c._handle("DONATION", {"donatorChannelId": "ch2", "donatorNickname": "d", "payAmount": "10000",
                                 "donationText": "힐 줘"})
    assert c.status["session_key"] == "k" and chats[0].text == "보스 소환" and chats[0].ts == 1700000000
    assert dons[0].amount == 10000 and dons[0].text == "힐 줘"
