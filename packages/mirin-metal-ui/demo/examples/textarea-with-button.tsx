import { Button } from "../../src/components/button.tsx";
import { Textarea } from "../../src/components/textarea.tsx";

export default function TextareaWithButton() {
  return (
    <div className="grid w-full gap-2">
      <Textarea placeholder="Type your message here." />
      <Button>Send message</Button>
    </div>
  );
}
