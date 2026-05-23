class Localizer {
  formatPrice(amount: number | null): number | null {
    if (amount == null) {
      return null;
    }

    if (Number.isNaN(amount)) {
      return null;
    }

    if (amount < 0) {
      return null;
    }

    return parseFloat(amount.toFixed(2));
  }

  formatCurrency(amount: number | null): string {
    if (amount === null) {
      return "₹ N/A";
    }

    const formattedAmount = this.formatPrice(amount);

    if (formattedAmount === null) {
      return "₹ N/A";
    }

    return formattedAmount.toLocaleString("en-IN", {
      style: "currency",
      currency: "INR",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  formatDate(
    date: number | string | Date,
    extraOptions?: Intl.DateTimeFormatOptions,
  ): string {
    const d = new Date(date);

    const options: Intl.DateTimeFormatOptions = {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      ...(extraOptions ?? {}),
    };

    try {
      return new Intl.DateTimeFormat("en-IN", {
        ...options,
        timeZone: "Asia/Kolkata",
      }).format(d);
    } catch {
      // ✅ fallback: no timezone if not supported
      return new Intl.DateTimeFormat("en-IN", options).format(d);
    }
  }

  static Init(): Localizer {
    return new Localizer();
  }
}

export const localizer = Localizer.Init();
