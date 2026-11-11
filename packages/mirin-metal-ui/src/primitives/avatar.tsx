/**
 * Radix `Avatar` on Metal: `Root`, `Image`, `Fallback`. The image resolves
 * through the `<img>` cache (`resolveImage`); the fallback shows until the
 * image has loaded, and stays if it fails or there is no `src`.
 */

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import { Slot } from "../lib/slot.tsx";
import { resolveImage } from "../runtime/media.tsx";

type Props = Record<string, unknown> & {
  children?: ReactNode;
  className?: string;
  asChild?: boolean;
};

type Status = "idle" | "loading" | "loaded" | "error";

interface AvatarApi {
  status: Status;
  setStatus: (status: Status) => void;
}

const AvatarContext = createContext<AvatarApi>({ status: "idle", setStatus: () => {} });

function Root({ asChild, ...props }: Props) {
  const [status, setStatus] = useState<Status>("idle");
  return (
    <AvatarContext.Provider value={{ status, setStatus }}>
      {asChild ? <Slot {...props} /> : <span {...props} />}
    </AvatarContext.Provider>
  );
}

function Image({
  src,
  onLoadingStatusChange,
  asChild,
  ...props
}: Props & { src?: string; onLoadingStatusChange?: (status: Status) => void }) {
  const avatar = useContext(AvatarContext);
  const [status, setStatus] = useState<Status>(src ? "loading" : "error");
  useEffect(() => {
    let live = true;
    if (!src) {
      setStatus("error");
      return;
    }
    setStatus("loading");
    void resolveImage(src).then((path) => {
      if (live) setStatus(path ? "loaded" : "error");
    });
    return () => {
      live = false;
    };
  }, [src]);
  const { setStatus: report } = avatar;
  useLayoutEffect(() => {
    report(status);
    onLoadingStatusChange?.(status);
  }, [status, report, onLoadingStatusChange]);
  if (status !== "loaded") return null;
  const shared: Props = { ...props, src };
  return asChild ? <Slot {...shared} /> : <img {...shared} />;
}

function Fallback({ delayMs, asChild, ...props }: Props & { delayMs?: number }) {
  const avatar = useContext(AvatarContext);
  const [ready, setReady] = useState(delayMs === undefined);
  useEffect(() => {
    if (delayMs === undefined) return;
    const timer = setTimeout(() => setReady(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);
  if (!ready || avatar.status === "loaded") return null;
  return asChild ? <Slot {...props} /> : <span {...props} />;
}

export const Avatar = { Root, Image, Fallback };
