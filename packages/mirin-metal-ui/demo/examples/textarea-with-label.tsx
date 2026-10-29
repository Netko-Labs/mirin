import { Label } from "../../src/components/label.tsx";
import { Textarea } from "../../src/components/textarea.tsx";

export default function TextareaWithLabel() {
  return (
    <div className="grid w-full gap-3">
      <Label htmlFor="message">Your message</Label>
      <Textarea placeholder="Type your message here." id="message" />
    </div>
  );
}
