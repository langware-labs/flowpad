export function alert(
  title: string,
  message: string,
  variant: 'success' | 'primary' | 'warning' | 'danger' = 'primary',
  clickHandler?: () => void,
) {
  window.dispatchEvent(new AlertEvent(title, message, variant, clickHandler));
}

export class AlertEvent extends Event {
  constructor(
    title: string,
    message: string,
    variant: 'success' | 'primary' | 'warning' | 'danger',
    clickHandler?: () => void,
  ) {
    super('alert');
    this.title = title;
    this.message = message;
    this.variant = variant;
    this.clickHandler = clickHandler;
  }
  title: string;
  message: string;
  variant: 'success' | 'primary' | 'warning' | 'danger';
  clickHandler?: () => void;
}
