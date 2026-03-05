// app/layout.js
import "./globals.css";

export const metadata = {
  title: "DSW Scheduler",
  description: "Dynamic scheduling tool with OT, shared support, gaps, calendar print",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
