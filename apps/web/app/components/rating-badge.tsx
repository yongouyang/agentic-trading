import type { Rating } from "../types";

const LABELS: Record<Rating, string> = {
  strong_sell: "strong sell",
  sell: "sell",
  hold: "hold",
  buy: "buy",
  strong_buy: "strong buy",
};

export function RatingBadge({ rating }: { rating: Rating | null }) {
  if (rating === null) {
    return (
      <span data-testid="rating-badge" className="badge badge--none">
        —
      </span>
    );
  }
  return (
    <span data-testid="rating-badge" className={`badge badge--${rating}`}>
      {LABELS[rating]}
    </span>
  );
}
