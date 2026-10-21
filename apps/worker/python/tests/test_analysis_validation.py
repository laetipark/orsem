from copy import deepcopy

from orsem_worker.analysis.validation import compare_facts, validate_facts


def fact(metric, value, **kwargs):
    return {
        "id": metric,
        "companyId": "company",
        "reportId": "report",
        "metric": metric,
        "accountId": "ifrs-full:" + ("Equity" if metric == "equity" else metric),
        "periodStart": None,
        "periodEnd": "2025-03-31",
        "reportCode": "11011",
        "scope": "CFS",
        "basis": "INSTANT",
        "currency": "KRW",
        "unit": "KRW",
        "value": value,
        "status": "AVAILABLE",
        **kwargs,
    }


def balance(values=("100", "60", "40"), **kwargs):
    return [fact(m, v, **kwargs) for m, v in zip(("assets", "liabilities", "equity"), values)]


def equation(facts):
    return [f for f in validate_facts(facts) if f["rule"] == "BALANCE_SHEET_EQUATION"]


def test_equation_preserves_huge_decimal_precision_and_missing_is_not_zero():
    assert (
        equation(balance(("999999999999999999999999.01", "999999999999999999999999", "0.01")))[0][
            "status"
        ]
        == "PASS"
    )
    missing = balance(("100", "100", None))
    missing[-1]["status"] = "NO_DATA"
    assert equation(missing)[0]["status"] == "UNAVAILABLE"
    assert equation(balance(("0", "0", "0")))[0]["status"] == "PASS"


def test_rounding_uses_only_declared_normalized_precision():
    assert equation(balance(("100", "60", "39"), precision="0"))[0]["status"] == "ROUNDING"
    assert equation(balance(("100", "60", "39")))[0]["status"] == "REVIEW"
    assert equation(balance(("100", "60", "39"), precision="INF"))[0]["status"] == "REVIEW"


def test_different_reports_currencies_and_parent_equity_cannot_pass():
    for key, value in (
        ("reportId", "another"),
        ("scope", "OFS"),
        ("currency", "USD"),
        ("periodEnd", "2024-03-31"),
    ):
        values = balance()
        values[-1][key] = value
        assert all(f["status"] == "UNAVAILABLE" for f in equation(values))
    values = balance()
    values[-1]["accountId"] = "us-gaap:StockholdersEquity"
    assert equation(values)[0]["status"] == "UNAVAILABLE"
    assert equation(balance(scope="UNKNOWN"))[0]["status"] == "UNAVAILABLE"


def test_duplicates_are_not_summed_and_checks_are_stable():
    values = balance() + [fact("equity", "40", id="other-equity")]
    findings = validate_facts(values)
    assert any(f["rule"] == "DUPLICATE_METRIC" for f in findings)
    assert equation(values)[0]["status"] == "UNAVAILABLE"
    assert findings == validate_facts(deepcopy(values))


def test_non_december_yoy_sign_changes_and_exact_values_do_not_mutate():
    previous = fact(
        "netIncome",
        "-12.25",
        id="previous",
        periodEnd="2024-03-31",
        basis="ANNUAL",
        periodStart="2023-04-01",
    )
    current = fact("netIncome", "5.75", id="current", basis="ANNUAL", periodStart="2024-04-01")
    original = deepcopy([previous, current])
    result = compare_facts(original)
    assert result[1]["comparison"] == {
        "previousFactId": "previous",
        "difference": "18",
        "percent": None,
        "transition": "PROFIT",
    }
    assert "comparison" not in original[1]
    previous["value"] = "0"
    assert compare_facts([previous, current])[1]["comparison"]["percent"] is None
    previous["value"] = "2.5"
    assert compare_facts([previous, current])[1]["comparison"]["percent"] == "130"


def test_yoy_rejects_scope_period_mapping_changes_and_ambiguous_prior_versions():
    previous = fact("revenue", "10", id="previous", periodEnd="2024-03-31")
    current = fact("revenue", "20", id="current")
    for key, value in (
        ("scope", "OFS"),
        ("currency", "USD"),
        ("basis", "YTD"),
        ("periodEnd", "2025-12-31"),
        ("mappingVersion", "new"),
    ):
        assert "comparison" not in compare_facts([previous, {**current, key: value}])[1]
    assert (
        "comparison" not in compare_facts([previous, {**previous, "id": "duplicate"}, current])[-1]
    )
