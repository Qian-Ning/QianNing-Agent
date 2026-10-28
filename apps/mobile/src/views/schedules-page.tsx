import { useEffect, useState } from "react";
import type { Translate } from "../lib/i18n";
import { alarmInfo, syncAlarms } from "../agent/alarms";
import {
  createSchedule,
  loadSchedules,
  removeSchedule,
  saveSchedule,
  toggleSchedule,
  type Schedule,
} from "../agent/schedules";

const INTERVALS = [15, 30, 60, 180, 1440] as const;

/**
 * Scheduled prompts. The page states its own limit — it fires while the app is
 * open — instead of implying a background alarm it does not set.
 */
export function SchedulesPage({ t }: { t: Translate }) {
  const [schedules, setSchedules] = useState<Schedule[]>(() => loadSchedules());
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [minutes, setMinutes] = useState<number>(INTERVALS[1]);
  const [armed, setArmed] = useState<string | null>(null);
  const [exact, setExact] = useState<boolean | null>(null);

  const refresh = () => {
    const next = loadSchedules();
    setSchedules(next);
    // Every edit re-places the system alarms: the list is the source of truth.
    void syncAlarms(next).then((result) => setExact(result.exact));
  };

  useEffect(() => {
    void alarmInfo().then((result) => setExact(result.exact));
  }, []);

  const add = () => {
    if (!title.trim() || !prompt.trim()) return;
    saveSchedule(createSchedule({ title, prompt, minutes }));
    setTitle("");
    setPrompt("");
    setMinutes(INTERVALS[1]);
    setAdding(false);
    refresh();
  };

  return (
    <>
      <p className="hint">{t("settings.schedules.hint")}</p>
      {exact === false ? <p className="hint">{t("settings.schedules.inexact")}</p> : null}

      {schedules.length === 0 && !adding ? (
        <div className="empty-state">
          <p>{t("settings.schedules.empty")}</p>
          <button className="primary" onClick={() => setAdding(true)}>
            {t("settings.schedules.add")}
          </button>
        </div>
      ) : null}

      <div className="settings-list">
        {schedules.map((schedule) => (
          <div key={schedule.id} className="schedule">
            <div className="schedule-head">
              <span className="row-title">{schedule.title}</span>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={schedule.enabled}
                  aria-label={schedule.title}
                  onChange={() => {
                    toggleSchedule(schedule.id, !schedule.enabled);
                    refresh();
                  }}
                />
                <span className="switch-track" />
              </label>
            </div>
            <p className="notice-body">{schedule.prompt}</p>
            <div className="schedule-foot">
              <span className="row-meta">
                {t("settings.schedules.interval")} {schedule.minutes} {t("settings.schedules.minutes")} ·{" "}
                {schedule.lastRunAt
                  ? t("settings.schedules.lastRun") + " " + new Date(schedule.lastRunAt).toLocaleString()
                  : t("settings.schedules.never")}
              </span>
              <button
                className="ghost tiny"
                onClick={() => {
                  if (armed === schedule.id) {
                    removeSchedule(schedule.id);
                    setArmed(null);
                    refresh();
                    return;
                  }
                  setArmed(schedule.id);
                }}
              >
                {armed === schedule.id ? t("settings.schedules.confirmDelete") : t("settings.schedules.delete")}
              </button>
            </div>
          </div>
        ))}
      </div>

      {adding ? (
        <div className="settings-list">
          <label>{t("settings.schedules.titleField")}</label>
          <input value={title} onChange={(event) => setTitle(event.target.value)} />
          <label>{t("settings.schedules.promptField")}</label>
          <textarea rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          <label>{t("settings.schedules.interval")}</label>
          <div className="levels">
            {INTERVALS.map((value) => (
              <button
                key={value}
                className={value === minutes ? "chip on" : "chip"}
                onClick={() => setMinutes(value)}
              >
                {value} {t("settings.schedules.minutes")}
              </button>
            ))}
          </div>
          <button className="primary" onClick={add} disabled={!title.trim() || !prompt.trim()}>
            {t("settings.schedules.save")}
          </button>
        </div>
      ) : schedules.length > 0 ? (
        <button className="add-row" onClick={() => setAdding(true)}>
          <span className="plus">+</span>
          {t("settings.schedules.add")}
        </button>
      ) : null}
    </>
  );
}
