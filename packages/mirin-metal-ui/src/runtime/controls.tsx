/**
 * Form controls: `<input>`, `<textarea>`, and `<select>`. Each works
 * controlled (`value` + `onChange`) and uncontrolled (`defaultValue`), and
 * hands handlers DOM-shaped events (`e.target.value`, `e.target.checked`).
 */

import { TextInput, type TextInputStyle } from "@mirinjs/metal";
import { isValidElement, type ReactNode, useContext, useMemo, useState } from "react";
import { DismissLayer, Portal } from "../overlay/host.tsx";
import { Popper } from "../overlay/popper.tsx";
import { useTheme } from "../theme.ts";
import { translate } from "../tw/index.ts";
import { Box, collectAttrs, TextRun } from "./box.tsx";
import { FormContext, useInherited } from "./context.ts";
import { syntheticEvent } from "./events.ts";
import { useFormField } from "./form.tsx";

type Props = Record<string, unknown>;
type Handler = ((event: ReturnType<typeof syntheticEvent>) => void) | undefined;

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
}

/** State that follows `value` when controlled and owns itself otherwise. */
function useFieldValue(props: Props): [string, (next: string) => void] {
  const controlled = props.value !== undefined && props.value !== null;
  const [own, setOwn] = useState(str(props.defaultValue) ?? "");
  const value = controlled ? (str(props.value) ?? "") : own;
  // Named controls take part in the enclosing form's FormData and reset.
  useFormField(str(props.name), props.disabled === true ? undefined : value, () =>
    setOwn(str(props.defaultValue) ?? ""),
  );
  return [value, (next) => !controlled && setOwn(next)];
}

function useInputStyle(props: Props, base: string): TextInputStyle {
  const theme = useTheme();
  const inherited = useInherited();
  const className = str(props.className);
  const attrs = collectAttrs(props);
  const key = JSON.stringify(attrs);
  // biome-ignore lint/correctness/useExhaustiveDependencies: key summarizes attrs
  return useMemo(() => {
    const tw = translate(`${base} ${className ?? ""}`, theme.colors, theme.radius, {
      attrs,
      groups: {},
      dark: theme.mode === "dark",
      viewportWidth: theme.viewportWidth,
    });
    const { view, input } = tw;
    const padding =
      view.paddingHorizontal ?? view.paddingLeft ?? view.padding ?? input.padding ?? undefined;
    return {
      color: inherited.text.color ?? theme.colors.foreground,
      fontSize: inherited.text.fontSize,
      placeholderColor: theme.colors.mutedForeground,
      focusBorderColor: theme.colors.ring,
      ...input,
      ...(padding !== undefined ? { padding } : {}),
      ...(typeof view.width === "number" ? { width: view.width } : {}),
      ...(typeof view.height === "number" ? { height: view.height } : {}),
      ...(view.minHeight !== undefined ? { minHeight: view.minHeight } : {}),
      ...(view.width === "100%" || view.flex || view.flexGrow ? { flex: 1 } : {}),
      ...(view.borderWidth === 0 ? { borderColor: "#00000000" } : {}),
    };
  }, [className, base, theme, key, inherited]);
}

export function HtmlInput(props: Props): ReactNode {
  const type = str(props.type) ?? "text";
  if (type === "hidden") return <HiddenInput {...props} />;
  if (type === "checkbox" || type === "radio") return <NativeCheck {...props} />;
  if (type === "file") return <FileInput {...props} />;
  return <TextField {...props} multiline={false} />;
}

export function HtmlTextarea(props: Props): ReactNode {
  return <TextField {...props} multiline />;
}

function TextField(props: Props & { multiline: boolean }) {
  const [value, setValue] = useFieldValue(props);
  const form = useContext(FormContext);
  const style = useInputStyle(props, props.multiline ? "min-h-16" : "");
  const disabled = props.disabled === true || props.readOnly === true;
  const onChange = props.onChange as Handler;
  const onKeyDown = props.onKeyDown as Handler;
  const name = str(props.name);
  return (
    <TextInput
      value={value}
      placeholder={str(props.placeholder)}
      multiline={props.multiline}
      secureTextEntry={props.type === "password"}
      autoFocus={props.autoFocus === true}
      testID={
        str(props.testID) ?? str(props["data-testid"]) ?? str(props.id) ?? str(props["data-slot"])
      }
      style={disabled ? { ...style, color: style.placeholderColor } : style}
      onChangeText={(text) => {
        if (disabled) return;
        setValue(text);
        onChange?.(syntheticEvent("change", { value: text, name, inputType: str(props.type) }));
      }}
      onSubmitEditing={(text) => {
        const event = syntheticEvent("keydown", { value: text, key: "Enter", name });
        onKeyDown?.(event);
        if (!event.defaultPrevented && !props.multiline) form?.submit();
      }}
    />
  );
}

/** `<input type="hidden">`: renders nothing, still submits its value. */
function HiddenInput(props: Props) {
  useFormField(str(props.name), str(props.value) ?? str(props.defaultValue) ?? "");
  return null;
}

function NativeCheck(props: Props) {
  const theme = useTheme();
  const controlled = props.checked !== undefined;
  const [own, setOwn] = useState(props.defaultChecked === true);
  const checked = controlled ? props.checked === true : own;
  useFormField(
    str(props.name),
    checked && props.disabled !== true ? (str(props.value) ?? "on") : undefined,
    () => setOwn(props.defaultChecked === true),
  );
  const onChange = props.onChange as Handler;
  const round = props.type === "radio";
  return (
    <Box
      viewStyle={{
        width: 16,
        height: 16,
        borderRadius: round ? 999 : 4,
        borderWidth: 1,
        borderColor: checked ? theme.colors.primary : theme.colors.input,
        backgroundColor: checked ? theme.colors.primary : undefined,
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={() => {
        if (props.disabled === true) return;
        if (!controlled) setOwn(!checked);
        onChange?.(
          syntheticEvent("change", { checked: !checked, value: str(props.value) ?? "on" }),
        );
      }}
    />
  );
}

function FileInput(props: Props) {
  return (
    <Box tag="div" className={`${str(props.className) ?? ""} flex flex-row items-center gap-2`}>
      <Box className="rounded-sm bg-muted px-2 py-0.5 text-sm font-medium">Choose File</Box>
      <Box className="text-sm text-muted-foreground">No file chosen</Box>
    </Box>
  );
}

interface Option {
  value: string;
  label: string;
  disabled: boolean;
  group?: string;
}

function collectOptions(children: unknown, group?: string): Option[] {
  const list = Array.isArray(children) ? children.flat(Number.POSITIVE_INFINITY) : [children];
  return list.flatMap((child): Option[] => {
    if (!isValidElement(child)) return [];
    const props = child.props as Props;
    const tag = str(props.__tag);
    if (tag === "optgroup") return collectOptions(props.children, str(props.label));
    if (tag !== "option" && !("value" in props)) return collectOptions(props.children, group);
    const label = Array.isArray(props.children)
      ? props.children.join("")
      : (str(props.children) ?? str(props.value) ?? "");
    return [{ value: str(props.value) ?? label, label, disabled: props.disabled === true, group }];
  });
}

/** `<select>`: a trigger showing the chosen option and a listbox popup. */
export function HtmlSelect(props: Props): ReactNode {
  const options = collectOptions(props.children);
  const [value, setValue] = useFieldValue({
    ...props,
    defaultValue: props.defaultValue ?? options[0]?.value,
  });
  const [anchor, setAnchor] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const onChange = props.onChange as Handler;
  const selected = options.find((option) => option.value === value);
  const disabled = props.disabled === true;
  return (
    <>
      <Box
        tag="button"
        className={`${str(props.className) ?? ""} flex flex-row items-center justify-between`}
        disabled={disabled}
        aria-invalid={props["aria-invalid"]}
        testID={str(props.testID) ?? str(props.id)}
        onClick={(event) => {
          const rect = event.target.getBoundingClientRect();
          setAnchor({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
        }}
      >
        <TextRun>{selected?.label ?? ""}</TextRun>
      </Box>
      {anchor ? (
        <Portal>
          <DismissLayer onDismiss={() => setAnchor(null)} />
          <Popper anchor={anchor} side="bottom" align="start" matchWidth>
            <Box className="flex max-h-72 flex-col overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
              {options.map((option) => (
                <Box
                  key={option.value}
                  className={`flex flex-row items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent ${option.value === value ? "bg-accent" : ""} ${option.disabled ? "opacity-50" : ""}`}
                  testID={`option:${option.value}`}
                  onClick={() => {
                    if (option.disabled) return;
                    setValue(option.value);
                    setAnchor(null);
                    onChange?.(
                      syntheticEvent("change", { value: option.value, name: str(props.name) }),
                    );
                  }}
                >
                  {option.label}
                </Box>
              ))}
            </Box>
          </Popper>
        </Portal>
      ) : null}
    </>
  );
}
