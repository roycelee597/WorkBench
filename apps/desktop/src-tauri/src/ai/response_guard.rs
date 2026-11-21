use super::{AiError, Result, protocol::ChatResponse};

const WRITE_VERBS: &[&str] = &[
    "新建", "创建", "添加", "新增", "修改", "更改", "编辑", "更新", "删除", "移除", "保存", "写入",
    "加入",
];
const STATE_VERBS: &[&str] = &["安排", "设置", "记录"];
const RECORD_SUBJECTS: &[&str] = &["日程", "提醒", "待办", "备忘录", "数据", "操作", "任务"];
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
    line.split_inclusive(['。', '！', '？', '!', '?'])
        .any(|sentence| {
            let has_ref = has_read_reference(sentence);
            sentence
                .trim_end_matches(['。', '！', '!'])
                .split(['，', '；', '：', ',', ';', ':'])
                .any(|clause| is_card_or_write_clause(clause, has_ref))
        })
}

fn is_card_or_write_clause(clause: &str, has_ref: bool) -> bool {
    let pending_heading = matches!(clause.trim(), "【待确认】" | "[待确认]");
    let clause = trim_presentation(clause);
    if clause.ends_with(['？', '?']) {
        return false;
    }
    let heading = clause
        .strip_prefix('「')
        .and_then(|text| text.strip_suffix('」'))
        .unwrap_or(clause);
    let is_card_heading = CARD_LABELS.iter().any(|&label| {
        heading.strip_prefix(label).is_some_and(|rest| {
            rest.is_empty()
                || rest.starts_with(['】', ']', '）', ')', '*', '`'])
                || rest.starts_with("占位")
                || rest.starts_with("已生成")
        })
    });
    pending_heading
        || clause.starts_with("待确认】")
        || clause.starts_with("待确认]")
        || is_card_heading
        || claims_write(clause, has_ref)
}

fn has_read_reference(text: &str) -> bool {
    text.split('[').skip(1).any(|tail| {
        let Some((reference, _)) = tail.split_once(']') else {
            return false;
        };
        matches!(reference.as_bytes(), [b'e' | b'r', b'1'..=b'9', digits @ ..]
            if digits.iter().all(u8::is_ascii_digit))
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

fn strip_prefix_any<'a>(text: &'a str, choices: &[&str]) -> Option<&'a str> {
    choices.iter().find_map(|&choice| text.strip_prefix(choice))
}

fn ends_in_success(text: &str) -> bool {
    let text = text.strip_suffix('了').unwrap_or(text);
    text.ends_with("成功")
        && WRITE_VERBS
            .iter()
            .chain(STATE_VERBS)
            .any(|&verb| text.starts_with(verb))
}

fn claims_write(part: &str, has_ref: bool) -> bool {
    let self_action = part.strip_prefix('我');
    let record_state = strip_prefix_any(part, RECORD_SUBJECTS);
    let part = self_action.or(record_state).unwrap_or(part);
    let Some(mut action) = strip_prefix_any(part, &["已经", "已", "成功"]) else {
        return !has_ref && ends_in_success(part);
    };
    let success_prefix = part.starts_with("成功") || action.starts_with("成功");
    let mut agentive = self_action.is_some();
    loop {
        if let Some(rest) =
            strip_prefix_any(action, &["为你", "为您", "帮你", "帮您", "替你", "替您"])
        {
            agentive = true;
            action = rest;
        } else if let Some(rest) = strip_prefix_any(action, &["成功", "完成"]) {
            action = rest;
        } else {
            break;
        }
    }
    // 带短引用的叙述通常在说明读取结果；只保留明确由助手执行的声明。
    if (!agentive && has_ref) || action.contains("失败") {
        return false;
    }
    if (action.starts_with("生成") || action.starts_with("准备"))
        && CARD_LABELS.iter().any(|&label| action.contains(label))
    {
        return true;
    }
    if ends_in_success(action) {
        return true;
    }
    if let Some(object_then_action) = action.strip_prefix('将') {
        return WRITE_VERBS.iter().any(|&verb| {
            object_then_action
                .rsplit_once(verb)
                .is_some_and(|(object, detail)| {
                    !object.is_empty() && !detail.starts_with(['的', '后', '时'])
                })
        });
    }
    if !agentive && !success_prefix && record_state.is_some() {
        // 保留「提醒已更新」这类独立的成功提示，带状态描述的句子不算操作。
        return WRITE_VERBS.contains(&action.strip_suffix('了').unwrap_or(action));
    }
    strip_prefix_any(action, WRITE_VERBS).is_some_and(|detail| {
        !detail.starts_with(['的', '后', '时'])
            && (agentive || !detail.starts_with(['在', '到', '为']))
    }) || ((agentive || success_prefix) && strip_prefix_any(action, STATE_VERBS).is_some())
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
