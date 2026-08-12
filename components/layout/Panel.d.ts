export interface PanelProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Panel label/title */
  label?: string;
  /** Panel content */
  children: React.ReactNode;
  /** Additional CSS class names */
  className?: string;
}

export function Panel(props: PanelProps): JSX.Element;
