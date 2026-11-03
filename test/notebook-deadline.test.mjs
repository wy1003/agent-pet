import test from "node:test";
import assert from "node:assert/strict";
import { calendarDates, deadlineText, localDateValue, normalizeDeadline, offsetDate, offsetMonth, parseDeadlineTime, validDateOnly } from "../public/notebook-deadline.mjs";

test("time input accepts hours, compact digits and full-width typing as HH:mm", () => {
  for (const [input, expected] of Object.entries({ "16": "16:00", "9": "09:00", "0": "00:00",
    "930": "09:30", "1630": "16:30", "0000": "00:00", "2359": "23:59", "9:5": "09:05",
    "16:": "16:00", " 16:30 ": "16:30", "１６：３０": "16:30", "18:45": "18:45" })) {
    assert.equal(parseDeadlineTime(input), expected, input);
    assert.equal(normalizeDeadline("2026-11-05", expected)?.deadlineTime, expected);
  }
});

test("empty optional time stays empty rather than creating a midnight deadline", () => {
  for (const input of [undefined, "", "  ", "　"]) assert.equal(parseDeadlineTime(input), "");
  assert.equal(parseDeadlineTime("00"), "00:00");
});

test("malformed and out-of-range time drafts are rejected without discarding them", () => {
  for (const input of ["24", "2400", "24:00", "12:60", "960", "9999", "-1", "-1:00", "16.5",
    "16:30:00", "1:234", "12345", ":30", "16h", "16:30Z", "16 30"]) assert.equal(parseDeadlineTime(input), null, input);
});

test("deadlines support unset, date only and minute precision without inventing a time", () => {
  assert.deepEqual(normalizeDeadline(), { deadline: "", deadlineTime: "" });
  assert.deepEqual(normalizeDeadline("2028-02-29"), { deadline: "2028-02-29", deadlineTime: "" });
  for (const time of ["00:00", "09:05", "18:30", "23:59"]) {
    assert.deepEqual(normalizeDeadline("2026-11-05", time), { deadline: "2026-11-05", deadlineTime: time });
  }
  assert.equal(normalizeDeadline("", "18:30"), null);
  for (const time of ["24:00", "18:60", "-1:00", "9:30", "09:5", "18:30:00", "18:30Z", " 18:30"]) {
    assert.equal(normalizeDeadline("2026-11-05", time), null);
  }
});

test("calendar accepts real dates and handles leap years and year boundaries", () => {
  for (const date of ["2028-02-29", "2000-02-29", "1000-01-01", "9999-12-31"]) assert.ok(validDateOnly(date));
  for (const date of ["2026-02-29", "1900-02-29", "2026-04-31", "0999-12-31", "10000-01-01", "2026-1-1", "2026-11-05T00:00:00Z"]) assert.equal(validDateOnly(date), false);
  assert.equal(offsetDate("2026-12-31", 1), "2027-01-01");
  assert.equal(offsetDate("2028-03-01", -1), "2028-02-29");
  assert.equal(offsetMonth("2028-01-31", 1), "2028-02-29");
  assert.equal(offsetMonth("2026-03-31", -1), "2026-02-28");
  assert.equal(offsetMonth("2028-02-29", 12), "2029-02-28");
});

test("calendar uses six Monday-first weeks including adjacent-month dates", () => {
  const dates = calendarDates("2026-11");
  assert.equal(dates.length, 42);
  assert.equal(new Set(dates).size, 42);
  assert.equal(dates[0], "2026-10-26");
  assert.equal(dates.at(-1), "2026-12-06");
  assert.equal(calendarDates("2026-06")[0], "2026-06-01");
  assert.equal(calendarDates("2028-02").filter(date => date.startsWith("2028-02")).length, 29);
});

test("deadline display keeps local wall-clock date and time unchanged", () => {
  assert.equal(deadlineText("", ""), "未设置");
  assert.equal(deadlineText("2026-11-05", ""), "2026/11/05");
  assert.equal(deadlineText("2026-11-05", "00:00"), "2026/11/05 00:00");
  assert.equal(deadlineText("2026-11-05", "18:30", { compact: true, year: 2026 }), "11/05 18:30");
  assert.equal(deadlineText("2027-01-01", "18:30", { compact: true, year: 2026 }), "2027/01/01 18:30");
  assert.equal(localDateValue(new Date(2026, 10, 5, 23, 59)), "2026-11-05");
});
