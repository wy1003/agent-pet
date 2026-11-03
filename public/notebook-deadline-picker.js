import { calendarDates, localDateValue, normalizeDeadline, offsetDate, offsetMonth, parseDeadlineTime, validDateOnly } from "./notebook-deadline.mjs";

/** Shared, cancelable date/time dialog for both the detail view and plan editor. */
export function createDeadlinePicker(dialog) {
  const $ = selector => dialog.querySelector(selector);
  let finish;
  let selected = "";
  let focused = "";
  let month = "";
  let today = "";
  const form = $("form");
  const timeInput = $("#deadline-time-input");
  const timeChoices = [...dialog.querySelectorAll("[data-deadline-time]")];

  function settle(value) {
    const resolve = finish;
    finish = null;
    dialog.close();
    resolve?.(value);
  }
  function updateTime() {
    timeInput.disabled = !selected;
    $("#deadline-confirm").disabled = !selected;
    $("#deadline-time-fields").classList.toggle("is-disabled", !selected);
    $("#deadline-clear-time").hidden = !timeInput.value;
    $("#deadline-clear-time").disabled = !selected;
    for (const choice of timeChoices) {
      choice.disabled = !selected;
      choice.setAttribute("aria-pressed", String(choice.dataset.deadlineTime === parseDeadlineTime(timeInput.value)));
    }
  }
  function showTimeError(message = "") {
    $("#deadline-picker-error").textContent = message;
    $("#deadline-picker-error").hidden = !message;
    $("#deadline-time-shortcuts").hidden = Boolean(message);
    timeInput.setAttribute("aria-invalid", String(Boolean(message)));
  }
  function normalizeTimeInput(reportError = false) {
    const time = parseDeadlineTime(timeInput.value);
    if (time !== null) { timeInput.value = time; showTimeError(); }
    else if (reportError) showTimeError("请输入有效时间，如 16:30。");
    updateTime();
    return time;
  }
  function renderCalendar(focusDay = false) {
    const [year, monthNumber] = month.split("-");
    $("#deadline-month-label").textContent = `${Number(year)}年${Number(monthNumber)}月`;
    $("#deadline-previous").disabled = month === "1000-01";
    $("#deadline-next").disabled = month === "9999-12";
    const grid = $("#deadline-days");
    grid.replaceChildren();
    const dates = calendarDates(month);
    for (let week = 0; week < 6; week++) {
      const row = document.createElement("div");
      row.className = "calendar-week";
      row.setAttribute("role", "row");
      for (const date of dates.slice(week * 7, week * 7 + 7)) {
        const cell = document.createElement("div");
        cell.setAttribute("role", "gridcell");
        cell.setAttribute("aria-selected", String(date === selected));
        const button = document.createElement("button");
        button.type = "button";
        button.className = "calendar-day";
        button.dataset.date = date;
        button.textContent = Number(date.slice(-2));
        button.disabled = !validDateOnly(date);
        button.tabIndex = date === focused ? 0 : -1;
        button.setAttribute("aria-label", date.replace("-", "年").replace("-", "月") + "日");
        button.classList.toggle("is-outside", !date.startsWith(month));
        button.classList.toggle("is-selected", date === selected);
        if (date === today) button.setAttribute("aria-current", "date");
        button.addEventListener("click", () => {
          selected = focused = date;
          month = date.slice(0, 7);
          renderCalendar(true);
          updateTime();
        });
        button.addEventListener("keydown", event => {
          const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
          let next;
          if (delta) next = offsetDate(date, delta);
          else if (event.key === "PageUp" || event.key === "PageDown") next = offsetMonth(date, (event.key === "PageUp" ? -1 : 1) * (event.shiftKey ? 12 : 1));
          else if (event.key === "Home" || event.key === "End") {
            const day = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
            next = offsetDate(date, (event.key === "Home" ? 0 : 6) - day);
          } else return;
          event.preventDefault();
          if (!validDateOnly(next)) return;
          focused = next;
          month = next.slice(0, 7);
          renderCalendar(true);
        });
        cell.append(button);
        row.append(cell);
      }
      grid.append(row);
    }
    if (focusDay) grid.querySelector(`[data-date="${focused}"]`)?.focus({ preventScroll: true });
  }
  function changeMonth(delta) {
    const next = offsetMonth(`${month}-01`, delta);
    if (!validDateOnly(next)) return;
    month = next.slice(0, 7);
    focused = selected.startsWith(month) ? selected : next;
    renderCalendar();
  }
  $("#deadline-previous").addEventListener("click", () => changeMonth(-1));
  $("#deadline-next").addEventListener("click", () => changeMonth(1));
  $("#deadline-today").addEventListener("click", () => {
    selected = focused = today;
    month = today.slice(0, 7);
    renderCalendar(true);
    updateTime();
  });
  $("#deadline-dismiss").addEventListener("click", () => settle(null));
  $("#deadline-unset").addEventListener("click", () => settle({ deadline: "", deadlineTime: "" }));
  timeInput.addEventListener("input", () => { showTimeError(); updateTime(); });
  timeInput.addEventListener("blur", () => normalizeTimeInput());
  $("#deadline-clear-time").addEventListener("click", () => {
    timeInput.value = "";
    showTimeError();
    updateTime();
    timeInput.focus();
  });
  for (const choice of timeChoices) choice.addEventListener("click", () => {
    timeInput.value = choice.dataset.deadlineTime;
    showTimeError();
    updateTime();
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    const time = normalizeTimeInput(true);
    if (time === null) { timeInput.focus(); return; }
    const result = normalizeDeadline(selected, time);
    if (!result || !selected) {
      showTimeError("请先选择截止日期。");
      return;
    }
    settle(result);
  });
  dialog.addEventListener("cancel", event => { event.preventDefault(); settle(null); });
  dialog.addEventListener("close", () => {
    // A close event from a previous opening must not cancel a newly opened dialog.
    if (dialog.open) return;
    const resolve = finish;
    finish = null;
    resolve?.(null);
  });
  return {
    isOpen: () => dialog.open,
    pick({ deadline = "", deadlineTime = "" } = {}) {
      if (dialog.open) return Promise.resolve(null);
      today = localDateValue();
      selected = validDateOnly(deadline) ? deadline : "";
      focused = selected || today;
      month = focused.slice(0, 7);
      timeInput.value = selected ? deadlineTime : "";
      showTimeError();
      updateTime();
      renderCalendar();
      const promise = new Promise(resolve => { finish = resolve; });
      dialog.showModal();
      $("#deadline-days").querySelector(`[data-date="${focused}"]`)?.focus({ preventScroll: true });
      return promise;
    },
  };
}
