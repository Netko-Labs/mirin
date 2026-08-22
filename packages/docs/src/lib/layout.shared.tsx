import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { KomeWordmark } from "@/components/kome";
import { gitConfig } from "./shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <KomeWordmark />,
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
