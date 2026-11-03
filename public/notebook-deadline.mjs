// Deadline dates and times are local wall-clock strings, not UTC timestamps.
export function validDateOnly(value) {
  return typeof value === "string" && /^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function normalizeDeadline(date = "", time = "") {
  if (!date) return time ? null : { deadline: "", deadlineTime: "" };
  if (!validDateOnly(date) || (time !== "" && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))) return null;
  return { deadline: date, deadlineTime: time };
}

// Accept convenient typing at the UI boundary; stored deadlines stay strict HH:mm.
// Empty text means date only, not midnight. Invalid text must never silently clear a time.
export function parseDeadlineTime(value = "") {
  const text = String(value).normalize("NFKC").trim();
  if (!text) return "";
  let hour, minute;
  if (/^\d{1,2}$/.test(text)) [hour, minute] = [text, "00"];
  else if (/^\d{3,4}$/.test(text)) [hour, minute] = [text.slice(0, -2), text.slice(-2)];
  else {
    const match = /^(\d{1,2}):(\d{0,2})$/.exec(text);
    if (!match) return null;
    [, hour, minute] = match;
    minute ||= "00";
  }
  if (Number(hour) > 23 || Number(minute) > 59) return null;
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

export function localDateValue(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function utcDateValue(date) {
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function offsetDate(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return utcDateValue(date);
}

export function offsetMonth(value, months) {
  const date = new Date(`${value}T00:00:00Z`);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const last = new Date(date);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  date.setUTCDate(Math.min(day, last.getUTCDate()));
  return utcDateValue(date);
}

export function calendarDates(month) {
  const first = `${month}-01`;
  const weekday = new Date(`${first}T00:00:00Z`).getUTCDay();
  const start = offsetDate(first, -((weekday + 6) % 7));
  return Array.from({ length: 42 }, (_, index) => offsetDate(start, index));
}

export function deadlineText(date, time = "", { compact = false, year = new Date().getFullYear() } = {}) {
  if (!date) return "未设置";
  const displayDate = compact && date.slice(0, 4) === String(year) ? date.slice(5) : date;
  return `${displayDate.replaceAll("-", "/")}${time ? ` ${time}` : ""}`;
}
