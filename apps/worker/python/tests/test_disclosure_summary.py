from orsem_worker.disclosures.summary import parsed_summary

BUY = {
    "nature": "MARKET_BUY",
    "direction": "INCREASE",
    "quantity": "1000",
    "methodRaw": "장내매수",
    "securityTypeRaw": "보통주",
}
PARSED = {
    "detailType": "D002",
    "reporterName": "홍길동",
    "positionRaw": "대표이사",
    "transactions": [BUY],
}


def test_completed_summary_groups_exact_quantities_and_names_company():
    assert parsed_summary(PARSED, "삼성전자") == (
        "[매수신호] (삼성전자) 홍길동 대표이사 +1,000주 장내매수"
    )
    assert parsed_summary({**PARSED, "transactions": [BUY, {**BUY, "quantity": "2000"}]}) == (
        "[매수신호] 홍길동 대표이사 +3,000주 장내매수"
    )
    assert "+9,223,372,036,854,775,807주" in parsed_summary(
        {
            **PARSED,
            "transactions": [{**BUY, "quantity": "9223372036854775807"}],
        }
    )


def test_sells_mixed_trades_and_securities_preserve_their_facts():
    sell = {
        **BUY,
        "nature": "MARKET_SELL",
        "direction": "DECREASE",
        "quantity": "-200",
        "methodRaw": "장내매도",
    }
    assert parsed_summary({**PARSED, "transactions": [sell]}, "삼성전자") == (
        "[매도신호] (삼성전자) 홍길동 대표이사 -200주 장내매도"
    )
    assert parsed_summary({**PARSED, "transactions": [BUY, sell]}) == (
        "[매수신호] [매도신호] 홍길동 대표이사 +1,000주 장내매수 · -200주 장내매도"
    )
    assert parsed_summary(
        {**PARSED, "transactions": [BUY, {**BUY, "securityTypeRaw": "우선주"}]}
    ) == ("[매수신호] 홍길동 대표이사 보통주 +1,000주 장내매수 · 우선주 +1,000주 장내매수")


def test_gifts_unknown_methods_missing_zero_conflicting_quantities_and_plans_are_not_signals():
    for row in (
        {**BUY, "nature": "GIFT", "methodRaw": "수증"},
        {**BUY, "nature": "UNKNOWN", "methodRaw": "기타 증가"},
        {**BUY, "quantity": None},
        {**BUY, "quantity": "0"},
        {**BUY, "quantity": "-1", "direction": "DECREASE"},
    ):
        assert parsed_summary({**PARSED, "transactions": [row]}).startswith("[소유변동]")
    assert parsed_summary({**PARSED, "detailType": "D005", "planItems": [BUY]}, "삼성전자") == (
        "[주식 거래계획] (삼성전자) 홍길동 대표이사 1,000주 장내매수 예정"
    )
    assert parsed_summary(
        {"detailType": "D001", "reporterName": "홍길동", "reportReasonRaw": "담보계약 변경"},
        "삼성전자",
    ) == ("[대량보유 공시] (삼성전자) 홍길동 담보계약 변경")
