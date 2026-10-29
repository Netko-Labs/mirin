import { NativeSelect, NativeSelectOption } from "../../src/components/native-select.tsx";

export default function NativeSelectDisabled() {
  return (
    <NativeSelect disabled>
      <NativeSelectOption value="">Select priority</NativeSelectOption>
      <NativeSelectOption value="low">Low</NativeSelectOption>
      <NativeSelectOption value="medium">Medium</NativeSelectOption>
      <NativeSelectOption value="high">High</NativeSelectOption>
      <NativeSelectOption value="critical">Critical</NativeSelectOption>
    </NativeSelect>
  );
}
