import { getFlagIconClass } from "@/lib/flag-utils";
import { cn } from "@/lib/utils";

interface FlagIconProps {
  countryCode?: string;
  className?: string;
}

export function FlagIcon({ countryCode, className }: FlagIconProps) {
  if (!countryCode) {
    return null;
  }

  const flagClass = getFlagIconClass(countryCode);
  if (!flagClass) {
    return null;
  }

  return <span className={cn(flagClass, className)} />;
}
