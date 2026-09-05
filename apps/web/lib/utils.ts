import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["display", "title", "body", "ui", "micro"] }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const COLOR_PALETTE = ['#958DF1', '#F98181', '#FBBC88', '#70CFF8', '#94FADB', '#B9F18D', '#F9C74F'];

export function getUserColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = ((hash << 5) - hash) + seed.charCodeAt(i);
  return COLOR_PALETTE[Math.abs(hash) % COLOR_PALETTE.length];
}
