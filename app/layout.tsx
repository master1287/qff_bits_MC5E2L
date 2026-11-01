import type { Metadata } from "next";
import "./globals.css";
import "./fonts.css";

export const metadata: Metadata = {
  title: "Qubit — BB84 Messenger",
  description: "Choose a BB84 disturbance-detection target, watch five qubits on IBM Quantum hardware, then start an encrypted conversation.",
  icons: { icon: "/favicon.svg" },
};
export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {
  return <html lang="en"><body>{children}</body></html>;
}
