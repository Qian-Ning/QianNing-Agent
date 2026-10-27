import { useEffect, useState } from "react";
import type { HostClient, ThinkingLevel } from "../lib/racp";
import type { Translate } from "../lib/i18n";

const THINKING: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

type Props = {
  t: Translate;
  client: HostClient;
  model: string;
  thinking: ThinkingLevel;
  onClose: () => void;
  onApply: (patch: { modelId: string; thinking: ThinkingLevel }) => void;
};

/**
 * The desktop's model picker, reduced to what a phone can do: the list the
 * endpoint advertises, and how hard to think. Both are read from the provider in
 * use, so a different model or level takes effect on the next turn.
 */
export function ModelSheet({ t, client, model, thinking, onClose, onApply }: Props) {
  const [models, setModels] = useState<string[] | null>(null);
  const [chosen, setChosen] = useState(model);
  const [level, setLevel] = useState<ThinkingLevel>(thinking);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const list = (await client.listModels?.()) ?? [];
        if (live) setModels(list);
      } catch (cause) {
        if (!live) return;
        // A provider without /models is not an error state: the field below stays.
        setModels([]);
        setError(cause instanceof Error ? cause.message : t("error.generic"));
      }
    })();
    return () => {
      live = false;
    };
  }, [client, t]);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(event) => event.stopPropagation()}>
        <h2>{t("chat.model")}</h2>
        {models === null ? <p className="muted">{t("connect.busy")}</p> : null}
        {models !== null && models.length === 0 ? (
          <p className="muted">{t("model.none")}</p>
        ) : null}
        <div className="model-list">
        {models?.map((id) => (
          <button
            key={id}
            className={"row" + (id === chosen ? " chosen" : "")}
            onClick={() => setChosen(id)}
          >
            <span className="row-title">
              {id}
              {id === chosen ? <span className="tick"> ✓</span> : null}
            </span>
          </button>
        ))}
        </div>
        {models !== null && models.length === 0 ? (
          <input
            value={chosen}
            onChange={(event) => setChosen(event.target.value)}
            placeholder={t("local.modelHint")}
          />
        ) : null}

        <h2 className="sheet-sub">{t("chat.thinking")}</h2>
        <div className="levels">
          {THINKING.map((entry) => (
            <button
              key={entry}
              className={"level" + (entry === level ? " chosen" : "")}
              onClick={() => setLevel(entry)}
            >
              {t(("model.level." + entry) as "model.level.off")}
            </button>
          ))}
        </div>

        {error ? <p className="muted">{error}</p> : null}

        <button
          className="primary wide"
          disabled={!chosen.trim()}
          onClick={() => onApply({ modelId: chosen.trim(), thinking: level })}
        >
          {t("local.save")}
        </button>
        <button className="ghost wide" onClick={onClose}>
          {t("sessions.cancel")}
        </button>
      </div>
    </div>
  );
}
