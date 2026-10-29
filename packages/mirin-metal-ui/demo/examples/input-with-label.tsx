import { Input } from "../../src/components/input.tsx";
import { Label } from "../../src/components/label.tsx";

export default function InputWithLabel() {
  return (
    <div className="grid w-full max-w-sm items-center gap-3">
      <Label htmlFor="email">Email</Label>
      <Input type="email" id="email" placeholder="Email" />
    </div>
  );
}
