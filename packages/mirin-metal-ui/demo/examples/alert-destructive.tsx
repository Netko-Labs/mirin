import { Alert, AlertDescription, AlertTitle } from "../../src/components/alert.tsx";
import { AlertCircleIcon } from "../../src/icons/index.ts";

export default function AlertDestructive() {
  return (
    <Alert variant="destructive">
      <AlertCircleIcon />
      <AlertTitle>Error</AlertTitle>
      <AlertDescription>Your session has expired. Please log in again.</AlertDescription>
    </Alert>
  );
}
