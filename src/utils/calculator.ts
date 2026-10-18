export interface ItemCalculationInput {
  quantity: number;
  unitPrice: number;
  isPurchased?: boolean | number;
}

export interface ListTotalsResult {
  totalItems: number;
  purchasedItems: number;
  estimatedTotal: number;
  purchasedTotal: number;
  budget: number;
  remainingBudget: number;
  budgetUsagePercent: number;
  isBudgetWarning: boolean;
  isBudgetExceeded: boolean;
}

/**
 * Calculate line item total using integer cents to prevent floating-point anomalies.
 */
export function calculateLineTotal(quantity: number, unitPrice: number): number {
  if (isNaN(quantity) || quantity < 0 || isNaN(unitPrice) || unitPrice < 0) {
    return 0;
  }
  const qtyCents = Math.round(quantity * 1000); // 3 decimals for fractional weights like 0.250 kg
  const priceCents = Math.round(unitPrice * 100);
  const totalCents = Math.round((qtyCents * priceCents) / 1000);
  return totalCents / 100;
}

/**
 * Compute aggregate list totals and budget alerts.
 */
export function calculateListTotals(
  items: ItemCalculationInput[],
  budget: number = 0
): ListTotalsResult {
  let estimatedTotalCents = 0;
  let purchasedTotalCents = 0;
  let purchasedCount = 0;

  for (const item of items) {
    const lineTotal = calculateLineTotal(item.quantity, item.unitPrice);
    const lineCents = Math.round(lineTotal * 100);
    estimatedTotalCents += lineCents;

    const isPurchased = Boolean(item.isPurchased);
    if (isPurchased) {
      purchasedCount++;
      purchasedTotalCents += lineCents;
    }
  }

  const estimatedTotal = estimatedTotalCents / 100;
  const purchasedTotal = purchasedTotalCents / 100;
  const sanitizedBudget = isNaN(budget) || budget < 0 ? 0 : Math.round(budget * 100) / 100;
  const remainingBudget = Math.round((sanitizedBudget - estimatedTotal) * 100) / 100;

  let budgetUsagePercent = 0;
  if (sanitizedBudget > 0) {
    budgetUsagePercent = Math.round((estimatedTotal / sanitizedBudget) * 1000) / 10;
  }

  return {
    totalItems: items.length,
    purchasedItems: purchasedCount,
    estimatedTotal,
    purchasedTotal,
    budget: sanitizedBudget,
    remainingBudget,
    budgetUsagePercent,
    isBudgetWarning: sanitizedBudget > 0 && budgetUsagePercent >= 80 && budgetUsagePercent < 100,
    isBudgetExceeded: sanitizedBudget > 0 && budgetUsagePercent >= 100
  };
}
