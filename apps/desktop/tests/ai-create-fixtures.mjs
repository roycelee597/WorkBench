// 只供离线验收；日期按北京时间自然日计算，不读取业务数据或凭据。
const DAY_MS = 86_400_000;
function localDay(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (name) => Number(parts.find((item) => item.type === name)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day"));
}
const date = (day) => new Date(day).toISOString().slice(0, 10);
const at = (day, time) => `${date(day)}T${time}`;
function call(name, value, index = 1) {
  return {
    id: `a3_${name}_${index}`,
    type: "function",
    function: { name, arguments: JSON.stringify(value) },
  };
}

/** 返回上游响应格式；不认识的句子保持原模拟服务的文字回复。 */
export function createActionFixture(text, now = Date.now()) {
  if (typeof text !== "string") return null;
  const message = text
    .trim()
    .replace(/\s+/g, "")
    .replace(/[，,。!！]/g, "");
  const today = localDay(now);
  const tomorrow = today + DAY_MS;
  let workday = tomorrow;
  while ([0, 6].includes(new Date(workday).getUTCDay())) workday += DAY_MS;
  const mondayIndex = (new Date(today).getUTCDay() + 6) % 7;
  const nextWednesday = today + (7 - mondayIndex + 2) * DAY_MS;
  let badminton = tomorrow;
  while (![2, 4].includes(new Date(badminton).getUTCDay())) badminton += DAY_MS;

  if (message === "明天下午三点提醒我交实验报告") {
    return [call("reminders_create", { title: "交实验报告", due: at(tomorrow, "15:00") })];
  }
  if (message === "每个工作日早上8点提醒我背单词") {
    return [
      call("reminders_create", {
        title: "背单词",
        due: at(workday, "08:00"),
        repeat: { preset: "workdays" },
      }),
    ];
  }
  if (message === "下周三下午三点到四点和导师开会提前半小时提醒") {
    return [
      call("calendar_create_event", {
        title: "和导师开会",
        start: at(nextWednesday, "15:00"),
        end: at(nextWednesday, "16:00"),
        remind_before_minutes: 30,
      }),
    ];
  }
  if (message === "每周二四晚上七点打羽毛球持续到12月底") {
    return [
      call("calendar_create_event", {
        title: "打羽毛球",
        start: at(badminton, "19:00"),
        duration_minutes: 60,
        repeat: {
          preset: "weekly",
          weekdays: [2, 4],
          end: { type: "until", until: `${new Date(today).getUTCFullYear()}-12-31` },
        },
      }),
    ];
  }
  if (["记一下：实验室门禁找张老师", "记一下:实验室门禁找张老师"].includes(message)) {
    return [call("memos_create", { title: "实验室门禁", content: "实验室门禁找张老师" })];
  }
  if (message === "A3:rounding") {
    return [
      call("calendar_create_event", {
        title: "提前提醒取档演示",
        start: at(tomorrow, "15:00"),
        remind_before_minutes: 20,
      }),
    ];
  }
  if (message === "A3:past") {
    return [call("reminders_create", { title: "过去时间演示", due: at(today - DAY_MS, "15:00") })];
  }
  if (message === "A3:multiple") {
    return [
      call("reminders_create", { title: "多卡片提醒", due: at(tomorrow, "15:00") }),
      call("memos_create", { title: "多卡片备忘录", content: "两张卡片分别确认或取消。" }, 2),
    ];
  }
  return null;
}
