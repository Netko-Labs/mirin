import { Callout } from "fumadocs-ui/components/callout";
import { File, Files, Folder } from "fumadocs-ui/components/files";
import { Step, Steps } from "fumadocs-ui/components/steps";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import { CheckRun } from "@/components/explainers/check-run";
import { PlatformPicker } from "@/components/explainers/platform-picker";
import { ProcessLanes } from "@/components/explainers/process-lanes";
import { RpcFlow } from "@/components/explainers/rpc-flow";
import { WindowPlayground } from "@/components/explainers/window-playground";

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    CheckRun,
    PlatformPicker,
    ProcessLanes,
    RpcFlow,
    WindowPlayground,
    Callout,
    File,
    Files,
    Folder,
    Step,
    Steps,
    Tab,
    Tabs,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
