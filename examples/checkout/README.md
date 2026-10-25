# Checkout example

`src/cart.ts` is the code an agent writes; `src/cart.laws.ts` is the person's side. Two laws: a shopper is never charged a
negative amount, and a coupon never raises the total.

```sh
npx tslaws check
```

Expected: both laws are **proved**. Now make the mistake an agent could make, in `cart.ts`:

```ts
return price - coupon; // was Math.max(0, price - coupon)
```

`totalNeverNegative` now **fails** with the smallest case that breaks it, `[0,1]` (an empty basket and a coupon of 1), and a
seed to replay it. Fix the code, not the law, and rerun.
