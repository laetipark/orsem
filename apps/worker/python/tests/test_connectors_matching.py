"""Deployed matcher parity and large-master lazy-regex regression."""

import pytest

from orsem_worker.connectors.policy import CompanyMatcher, alias_expression, company_aliases


def catalog(count):
    return [
        {
            "id": f"company-{index}",
            "nameKo": f"검증기업{index:05}",
            "nameEn": f"Verification Enterprise {index:05} Incorporated",
            "ticker": f"VX{index}",
            "stockCode": None,
        }
        for index in range(count)
    ]


def test_large_master_compiles_only_title_candidates():
    # Compiling all aliases here previously grew to >1 GiB at the deployed
    # 128,814-company scale. No unknown title may compile a master-wide pattern.
    alias_expression.cache_clear()
    match = CompanyMatcher(company_aliases(catalog(9140)))
    assert alias_expression.cache_info().currsize == 0
    assert match("Central bank discusses inflation and monetary policy") == []
    assert alias_expression.cache_info().currsize == 0
    for index in (0, 17, 999, 9139):
        assert match(f"Verification Enterprise {index:05} Incorporated earnings") == [
            f"company-{index}"
        ]
        assert match(f"검증기업{index:05}의 실적 발표") == [f"company-{index}"]
        assert match(f"($VX{index}) shares") == [f"company-{index}"]
        assert match(f"검증기업{index:05}서비스 실적 발표") == []
    assert alias_expression.cache_info().currsize <= 32


@pytest.mark.parametrize(
    ("title", "expected"),
    [
        ("$ABC and $abc", ["symbol"]),
        ("οσος earnings", ["greek"]),
        ("ACME earnings", ["width"]),
        ("A+B earnings", ["literal"]),
        ("AxB earnings", []),
        ("(DX) generic acronym", []),
        ("NYSE:DX earnings", ["explicit"]),
        ("$dx earnings", []),
        ("가나다ABC와 실적 발표", ["mixed"]),
        ("가나다abc와 실적 발표", []),
    ],
)
def test_index_preserves_deployed_unicode_and_symbol_boundaries(title, expected):
    match = CompanyMatcher(
        [
            {"companyId": "symbol", "alias": "ABC", "aliasType": "SYMBOL"},
            {"companyId": "symbol", "alias": "abc", "aliasType": "SYMBOL"},
            {"companyId": "greek", "alias": "ΟΣΟΣ", "aliasType": "NAME"},
            {"companyId": "width", "alias": "ＡＣＭＥ", "aliasType": "NAME"},
            {"companyId": "literal", "alias": "A+B", "aliasType": "NAME"},
            {"companyId": "explicit", "alias": "DX", "aliasType": "EXPLICIT_SYMBOL"},
            {"companyId": "mixed", "alias": "가나다ABC", "aliasType": "NAME"},
        ]
    )
    assert match(title) == expected


def test_index_preserves_ambiguous_and_contained_alias_rules():
    match = CompanyMatcher(
        [
            {"companyId": "a", "alias": "Acme", "aliasType": "NAME"},
            {"companyId": "b", "alias": "ACME", "aliasType": "NAME"},
            {"companyId": "apple", "alias": "Apple", "aliasType": "NAME"},
            {"companyId": "short", "alias": "Example Holdings", "aliasType": "NAME"},
            {"companyId": "long", "alias": "Example Holdings Capital", "aliasType": "NAME"},
            {"companyId": "short", "alias": "EH", "aliasType": "SYMBOL"},
            {"companyId": "unlisted", "alias": "자금", "aliasType": "NAME"},
        ]
    )
    assert match("Acme ACME and Apple earnings") == []
    assert match("Example Holdings Capital earnings") == ["long"]
    assert match("Example Holdings Capital and $EH earnings") == ["long", "short"]
    # Relevance remains master-wide, including existing unlisted-name evidence.
    assert match("자금 지원 계획") == ["unlisted"]


def test_compiled_expression_cache_is_bounded_across_jobs():
    alias_expression.cache_clear()
    match = CompanyMatcher(company_aliases(catalog(600)))
    for index in range(600):
        assert match(f"($VX{index}) shares") == [f"company-{index}"]
    assert alias_expression.cache_info().currsize == 512
    assert match("($VX0) shares") == ["company-0"]
    assert alias_expression.cache_info().currsize == 512
