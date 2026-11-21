use super::{AiError, Result, protocol::ChatResponse};

const WRITE_VERBS: &[&str] = &[
    "新建", "创建", "添加", "新增", "修改", "更改", "编辑", "更新", "删除", "移除", "保存", "写入",
    "安排", "设置", "加入", "记录",
];
const CARD_LABELS: &[&str] = &[
    "确认卡片",
    "确认卡",
    "待确认卡片",
    "操作卡片",
    "待办卡片",
    "提醒卡片",
    "日程卡片",
    "备忘录卡片",
    "卡片占位",
];

fn trim_presentation(text: &str) -> &str {
    text.trim_matches(|character: char| {
        character.is_whitespace()
            || matches!(
                character,
                '*' | '_'
                    | '`'
                    | '#'
                    | '-'
                    | '['
                    | ']'
                    | '【'
                    | '】'
                    | '（'
                    | '）'
                    | '('
                    | ')'
                    | '✓'
                    | '✔'
                    | '☑'
                    | '✅'
                    | '\u{fe0f}'
            )
    })
}

fn is_card_or_write_claim(line: &str) -> bool {
    if (line.contains("[确认]") && line.contains("[取消]"))
        || (line.contains("【确认】") && line.contains("【取消】"))
    {
        return true;
    }
    line.split(['，', '。', '；', '：', '！', ',', ';', ':', '!'])
        .any(|part| {
            let pending_heading = matches!(part.trim(), "【待确认】" | "[待确认]");
            let part = trim_presentation(part);
            if part.ends_with(['？', '?']) {
                return false;
            }
            let heading = part
                .strip_prefix('「')
                .and_then(|text| text.strip_suffix('」'))
                .unwrap_or(part);
            let is_card_heading = CARD_LABELS.iter().any(|&label| {
                heading.strip_prefix(label).is_some_and(|rest| {
                    rest.is_empty()
                        || rest.starts_with(['】', ']', '）', ')', '*', '`'])
                        || rest.starts_with("占位")
                        || rest.starts_with("已生成")
                })
            });
            pending_heading
                || part.starts_with("待确认】")
                || part.starts_with("待确认]")
                || is_card_heading
                || claims_write(part)
        })
}

fn looks_like_proposal(text: &str) -> bool {
    let mut proposal = false;
    let mut subject = false;
    let mut details = false;
    for line in text.lines() {
        let (heading, value) = line.split_once(['：', ':']).unwrap_or((line, ""));
        match trim_presentation(heading) {
            "请确认以下操作"
            | "请确认以下待办"
            | "请确认以下提醒"
            | "请确认以下日程"
            | "请确认以下备忘录" => proposal = true,
            "标题" | "事项" | "待办名称" if proposal && !trim_presentation(value).is_empty() =>
            {
                subject = true;
            }
            "时间" | "日期" | "开始时间" | "到期时间" | "截止时间" | "提醒时间" | "优先级"
            | "正文"
                if proposal && !trim_presentation(value).is_empty() =>
            {
                details = true
            }
            _ => {}
        }
    }
    proposal && subject && details
}

fn claims_write(part: &str) -> bool {
    let part = [
        "我",
        "日程",
        "提醒",
        "待办",
        "备忘录",
        "数据",
        "操作",
        "任务",
    ]
    .iter()
    .find_map(|&subject| part.strip_prefix(subject))
    .unwrap_or(part);
    let Some(mut rest) = ["已经", "已", "成功"]
        .iter()
        .find_map(|&prefix| part.strip_prefix(prefix))
    else {
        return part.ends_with("成功") && WRITE_VERBS.iter().any(|&verb| part.starts_with(verb));
    };
    while let Some(next) = [
        "为你", "为您", "帮你", "帮您", "替你", "替您", "成功", "完成",
    ]
    .iter()
    .find_map(|&prefix| rest.strip_prefix(prefix))
    {
        rest = next;
    }
    if rest.contains("失败") {
        return false;
    }
    if let Some(subject) = rest.strip_prefix('将') {
        return WRITE_VERBS.iter().any(|&verb| subject.contains(verb));
    }
    if (rest.starts_with("生成") || rest.starts_with("准备"))
        && CARD_LABELS.iter().any(|&label| rest.contains(label))
    {
        return true;
    }
    WRITE_VERBS.iter().any(|&verb| {
        rest.strip_prefix(verb)
            .is_some_and(|object| !object.starts_with(['的', '后', '时']))
    })
}

pub(super) fn filter_reply(
    mut reply: ChatResponse,
    write_tools: &[String],
) -> Result<ChatResponse> {
    let claims_write = reply
        .content
        .as_deref()
        .is_some_and(|text| text.lines().any(is_card_or_write_claim) || looks_like_proposal(text));
    if claims_write {
        // 与工具编排一致，仅前五个调用可能产生操作卡片。
        if !reply
            .tool_calls
            .iter()
            .take(5)
            .any(|call| write_tools.contains(&call.name))
        {
            return Err(AiError::new("CARD_REQUIRED", "没有生成卡片，请重试"));
        }
        // 实际调用也只是请求生成草稿，不让上游文字暗示已经写入。
        reply.content = None;
    }
    Ok(reply)
}
