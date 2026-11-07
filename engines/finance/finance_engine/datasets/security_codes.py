"""有正式公告依据的证券代码变更，不把更换代码当作新上市或退市。"""

# 旧代码 -> (当前代码, 新代码生效日, 公告来源)。不据名称相似度推断身份。
CODE_CHANGES = {
    "000022.SZ": (
        "001872.SZ",
        20181226,
        "https://disc.static.szse.cn/disc/disk03/finalpage/2022-08-31/"
        "ebcdc89c-4be1-4632-b0a3-4adba3c7204e.PDF",
    ),
    "000043.SZ": (
        "001914.SZ",
        20191216,
        "https://www.szse.cn/disclosure/notice/general/t20191211_572534.html",
    ),
    "300114.SZ": (
        "302132.SZ",
        20250217,
        "https://static.cninfo.com.cn/finalpage/2025-02-07/1222485220.PDF",
    ),
}


def canonical_code(code: str, day: int) -> str:
    change = CODE_CHANGES.get(code)
    return change[0] if change and day < change[1] else code


def historical_code(code: str, day: int) -> str:
    for old, (current, effective, _) in CODE_CHANGES.items():
        if code == current and day < effective:
            return old
    return code
