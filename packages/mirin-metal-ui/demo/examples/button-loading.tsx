import { Button } from "../../src/components/button.tsx";
import { Spinner } from "../../src/components/spinner.tsx";

export default function ButtonLoading() {
  return (
    <Button size="sm" variant="outline" disabled>
      <Spinner />
      Submit
    </Button>
  );
}
