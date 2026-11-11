/**
 * `react-textarea-autosize` on Metal: the default export renders a multiline
 * `<textarea>`. Metal text fields size to their content natively, so the
 * row/measurement props are accepted and dropped.
 */

import type { ReactNode } from "react";

export interface TextareaAutosizeProps extends Record<string, unknown> {
  minRows?: number;
  maxRows?: number;
  cacheMeasurements?: boolean;
  onHeightChange?: (height: number) => void;
}

export default function TextareaAutosize({
  minRows: _min,
  maxRows: _max,
  cacheMeasurements: _cache,
  onHeightChange: _height,
  ...props
}: TextareaAutosizeProps): ReactNode {
  return <textarea {...props} />;
}
