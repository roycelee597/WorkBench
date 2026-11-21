use super::{AiError, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub const DAILY_LIMIT: u32 = 300;
pub const MINUTE_LIMIT: u32 = 20;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CallLimits {
    pub enabled: bool,
    pub daily: u32,
    pub per_minute: u32,
}

impl Default for CallLimits {
    fn default() -> Self {
        Self {
            enabled: false,
            daily: DAILY_LIMIT,
            per_minute: MINUTE_LIMIT,
        }
    }
}

impl CallLimits {
    fn valid(self) -> bool {
        self.daily > 0 && self.per_minute > 0
    }
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

// 公历日期转换，仅使用固定 UTC+8；不依赖电脑时区或额外日期库。
pub fn beijing_date(seconds: u64) -> String {
    let days = (seconds / 86_400) as i64 + ((seconds % 86_400 + 28_800) / 86_400) as i64;
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    format!("{:04}-{month:02}-{day:02}", year + i64::from(month <= 2))
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Usage {
    pub date: String,
    pub calls: u32,
    pub minute: u64,
    pub minute_calls: u32,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}

impl Usage {
    fn empty(seconds: u64) -> Self {
        Self {
            date: beijing_date(seconds),
            calls: 0,
            minute: seconds / 60,
            minute_calls: 0,
            prompt_tokens: 0,
            completion_tokens: 0,
        }
    }

    fn refresh(&mut self, seconds: u64) {
        let date = beijing_date(seconds);
        // 系统时间回拨时不清零，防止意外绕过已有的限额。
        if date > self.date {
            *self = Self::empty(seconds);
        } else if seconds / 60 > self.minute {
            self.minute = seconds / 60;
            self.minute_calls = 0;
        }
    }

    fn valid(&self) -> bool {
        self.date == beijing_date(self.minute.saturating_mul(60)) && self.minute_calls <= self.calls
    }
}

pub struct UsageStore {
    path: PathBuf,
    value: Usage,
    limits: CallLimits,
}

impl UsageStore {
    pub fn load(directory: &Path, seconds: u64) -> Result<Self> {
        let path = directory.join("ai-usage.json");
        let config = directory.join("ai-config.json");
        let limits = match fs::read(&config) {
            Ok(bytes) => match serde_json::from_slice::<CallLimits>(&bytes)
                .ok()
                .filter(|value| value.valid())
            {
                Some(limits) => limits,
                None => {
                    let limits = CallLimits::default();
                    persist_json(&config, &limits)?;
                    audit(directory, "call_limits_recovered");
                    limits
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => CallLimits::default(),
            Err(_) => return Err(AiError::storage()),
        };
        let (mut value, corrupt) = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<Usage>(&bytes) {
                Ok(value) if value.valid() => (value, false),
                _ => (
                    Usage {
                        calls: limits.daily / 2,
                        minute_calls: (limits.per_minute / 2).min(limits.daily / 2),
                        ..Usage::empty(seconds)
                    },
                    true,
                ),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                (Usage::empty(seconds), false)
            }
            Err(_) => return Err(AiError::storage()),
        };
        value.refresh(seconds);
        let store = Self {
            path,
            value,
            limits,
        };
        if corrupt {
            audit(
                directory,
                &format!("usage_recovered calls={}", store.value.calls),
            );
            store.persist(&store.value)?;
        }
        Ok(store)
    }

    fn persist(&self, value: &Usage) -> Result<()> {
        persist_json(&self.path, value)
    }

    pub fn limits(&self) -> CallLimits {
        self.limits
    }

    pub fn set_limits(&mut self, limits: CallLimits) -> Result<()> {
        if !limits.valid() {
            return Err(AiError::bad());
        }
        persist_json(&self.path.with_file_name("ai-config.json"), &limits)?;
        self.limits = limits;
        Ok(())
    }

    pub fn snapshot(&mut self, seconds: u64) -> Usage {
        self.value.refresh(seconds);
        self.value.clone()
    }

    pub fn charge(&mut self, seconds: u64) -> Result<()> {
        let mut next = self.snapshot(seconds);
        if self.limits.enabled
            && (next.calls >= self.limits.daily || next.minute_calls >= self.limits.per_minute)
        {
            return Err(AiError::new(
                "LOCAL_LIMIT",
                "已达到设置中的每分钟或每日调用上限，请稍后再试或手动新建",
            ));
        }
        next.calls = next.calls.saturating_add(1);
        next.minute_calls = next.minute_calls.saturating_add(1);
        // 先落盘再交给 HTTP 发送；写盘失败不发送，不能产生未记录的计费调用。
        self.persist(&next)?;
        self.value = next;
        Ok(())
    }

    pub fn add_tokens(&mut self, prompt: u64, completion: u64, seconds: u64) -> Result<()> {
        self.value.refresh(seconds);
        self.value.prompt_tokens = self.value.prompt_tokens.saturating_add(prompt);
        self.value.completion_tokens = self.value.completion_tokens.saturating_add(completion);
        self.persist(&self.value)
    }
}

fn persist_json(path: &Path, value: &impl Serialize) -> Result<()> {
    fs::create_dir_all(path.parent().ok_or_else(AiError::storage)?)
        .map_err(|_| AiError::storage())?;
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(value).map_err(|_| AiError::storage())?;
    let mut file = fs::File::create(&temporary).map_err(|_| AiError::storage())?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| AiError::storage())?;
    drop(file);
    fs::rename(&temporary, path).map_err(|_| AiError::storage())
}

pub fn audit(directory: &Path, entry: &str) {
    // 调用方只传固定标记、白名单模型、数值和本地错误码，不接收正文或密钥。
    let write = || -> std::io::Result<()> {
        fs::create_dir_all(directory)?;
        let path = directory.join("ai-client.log");
        if fs::metadata(&path).is_ok_and(|meta| meta.len() > 1_048_576) {
            fs::rename(&path, directory.join("ai-client.log.1"))?;
        }
        writeln!(
            OpenOptions::new().create(true).append(true).open(path)?,
            "time={} {entry}",
            now()
        )
    };
    if write().is_err() {
        eprintln!("AI 日志写入失败");
    }
}
