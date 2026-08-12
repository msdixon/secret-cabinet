export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Card content */
  children: React.ReactNode;
  /** Additional CSS class names */
  className?: string;
}

export function Card(props: CardProps): JSX.Element;
