export const metadata = {
  title: "DSW Scheduler",
  description: "Supervisor scheduling + 40 hour overtime guard",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "Arial, sans-serif", background: "#F4F6F8", color: "#2F3742" }}>
        {children}
      </body>
    </html>
  );
}
