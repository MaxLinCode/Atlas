import type { ReactNode } from "react";

export const metadata = {
  title: "Atlas Admin",
  description: "Internal admin surface for the Atlas brain-dump scheduler.",
};

type RootLayoutProps = {
  children: ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: "Georgia, serif",
          background:
            "linear-gradient(180deg, #f3efe2 0%, #f8f6ee 40%, #ffffff 100%)",
          color: "#1f2a1f",
        }}
      >
        {children}
      </body>
    </html>
  );
}
