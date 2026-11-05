import { useId, useState } from "react";
import { Plus, Tag, X } from "lucide-react";
import { Button } from "@workbench/ui";
import { normalizeTags } from "../api";

export function TagInput({
  tags,
  suggestions,
  onChange,
  disabled,
}: {
  tags: string[];
  suggestions: string[];
  onChange: (tags: string[]) => void;
  disabled: boolean;
}) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const [highlighted, setHighlighted] = useState(false);
  const id = useId();
  const matches = suggestions
    .filter(
      (tag) => !tags.includes(tag) && tag.toLocaleLowerCase().includes(value.toLocaleLowerCase()),
    )
    .slice(0, 6);
  function add(tag: string) {
    if (tag.trim()) onChange(normalizeTags([...tags, tag]));
    setValue("");
    setActive(0);
  }
  return (
    <div className="tag-input-row">
      <Tag size={14} aria-hidden="true" className="text-muted-foreground" />
      {tags.map((tag) => (
        <span className="tag-chip" key={tag}>
          {tag}
          <button
            type="button"
            disabled={disabled}
            aria-label={`移除标签 ${tag}`}
            onClick={() => onChange(tags.filter((item) => item !== tag))}
          >
            <X size={12} />
          </button>
        </span>
      ))}
      <div className="tag-combobox">
        <input
          aria-label="添加标签"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={focused && matches.length > 0}
          aria-controls={id}
          aria-activedescendant={focused && matches.length ? `${id}-${active}` : undefined}
          placeholder="添加标签…"
          value={value}
          disabled={disabled}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            if (value.trim()) add(value);
          }}
          onChange={(event) => {
            setValue(event.target.value);
            setActive(0);
            setHighlighted(false);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape") setFocused(false);
            if (event.key === "ArrowDown" && matches.length) {
              event.preventDefault();
              setActive((active + 1) % matches.length);
              setFocused(true);
              setHighlighted(true);
            }
            if (event.key === "ArrowUp" && matches.length) {
              event.preventDefault();
              setActive((active + matches.length - 1) % matches.length);
              setHighlighted(true);
            }
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              add(
                focused && matches.length && (highlighted || !value.trim())
                  ? matches[active]!
                  : value,
              );
            }
            if (event.key === "Tab" && focused && value && matches[active]) {
              event.preventDefault();
              add(matches[active]!);
            }
          }}
        />
        {focused && matches.length > 0 && (
          <div id={id} role="listbox" aria-label="已用标签" className="tag-suggestions">
            <p>
              已用标签 <span>Tab 补全</span>
            </p>
            {matches.map((tag, index) => (
              <button
                type="button"
                role="option"
                aria-selected={active === index}
                id={`${id}-${index}`}
                key={tag}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => add(tag)}
              >
                <Tag size={13} />
                {tag}
              </button>
            ))}
          </div>
        )}
      </div>
      {value.trim() && (
        <Button
          size="icon"
          variant="ghost"
          disabled={disabled}
          aria-label="确认添加标签"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => add(value)}
        >
          <Plus />
        </Button>
      )}
    </div>
  );
}
