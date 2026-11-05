export interface BadgeTemplateProps {
  readonly classes: string;
  readonly label: string;
}

export default function BadgeTemplate({ classes, label }: BadgeTemplateProps) @{
  <span class={classes}>{label}</span>
}
