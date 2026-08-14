declare module "qrcode.react" {
  import type { ReactElement, SVGProps } from "react";
  export function QRCodeSVG(props: SVGProps<SVGSVGElement> & { value: string; size?: number }): ReactElement;
}
