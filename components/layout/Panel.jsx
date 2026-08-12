export function Panel({ children, label = '', className = '', ...props }) {
  return (
    <div className={`panel ${className}`.trim()} {...props}>
      {label && <div className="panel-label">{label}</div>}
      {children}
    </div>
  );
}
