import { Schema } from "effect";

export const Customer = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  email: Schema.NullOr(Schema.String),
  status: Schema.Literals(["lead", "active", "churned"]),
  openDeals: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  tags: Schema.Array(Schema.String),
}).annotate({ identifier: "Customer" });
export type Customer = typeof Customer.Type;

export function CustomerCard(props: { readonly customer: Customer }) {
  const { customer } = props;
  return (
    <article className="customer-card" data-status={customer.status}>
      <h2>{customer.name}</h2>
      <p>{customer.email ?? "No email"}</p>
      <p>
        {customer.openDeals} open {customer.openDeals === 1 ? "deal" : "deals"}
      </p>
      <ul>
        {customer.tags.map((tag, index) => (
          <li key={index}>{tag}</li>
        ))}
      </ul>
    </article>
  );
}
