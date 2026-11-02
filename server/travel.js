"use strict";
/*
 * Flights (Duffel) and hotels (liteAPI): search → compare → revalidate → pending booking →
 * customer approval + Razorpay payment → provider confirmation → My Trips; cancellation with refund.
 *
 * Every price shown to the customer is computed here from the provider's price, the owner's
 * exchange rates and service fee (site/config.travel). Bookings live in the server-only document
 * travel/<uid> (customers read their own; nobody writes it through the document API).
 */
const crypto = require("crypto");
const { todayISO, addDays } = require("./pricing");
const { deepMerge } = require("./store");

const DUFFEL = "https://api.duffel.com";
const LITE_SEARCH = "https://api.liteapi.travel/v3.0";
const LITE_BOOK = "https://book.liteapi.travel/v3.0";
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const IATA = /^[A-Z]{3}$/;
const E164 = /^\+\d{10,15}$/;

const minutes = iso => { const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(String(iso || "")); return m ? (+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0; };
const ageOn = (born, onDate) => { const b = new Date(born + "T00:00:00Z"), d = new Date(onDate + "T00:00:00Z"); let a = d.getUTCFullYear() - b.getUTCFullYear(); if (d < new Date(Date.UTC(d.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()))) a--; return a; };

function createTravel(ctx) {
  const { D, store, changed, HttpError, pay } = ctx;
  const fetchImpl = ctx.fetchImpl || globalThis.fetch;
  const duffelKey = ctx.duffelKey, liteKey = ctx.liteKey;
  const litePayment = ctx.litePaymentMethod || "ACC_CREDIT_CARD";
  const bad = m => new HttpError(400, m);
  const cache = new Map(); // offerId → { offer, at }  (search results, 30 min)
  const remember = (k, v) => { cache.set(k, { v, at: Date.now() }); if (cache.size > 5000) cache.delete(cache.keys().next().value); };
  const recall = k => { const c = cache.get(k); return c && Date.now() - c.at < 30 * 60e3 ? c.v : null; };

  /* ---------- provider HTTP ---------- */
  async function call(url, { method = "GET", headers = {}, body, timeoutMs = 25000 } = {}) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try { res = await fetchImpl(url, { method, headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal }); }
    catch (e) { throw new HttpError(504, e.name === "AbortError" ? "The travel provider took too long to answer. Please try again." : "Couldn't reach the travel provider. Please try again."); }
    finally { clearTimeout(t); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data.errors && data.errors[0] && (data.errors[0].message || data.errors[0].title)) || (data.error && (data.error.description || data.error.message)) || `Provider error ${res.status}`;
      throw Object.assign(new HttpError(res.status >= 500 ? 502 : 409, msg), { providerStatus: res.status });
    }
    return data;
  }
  const duffel = (path, opt = {}) => {
    if (!duffelKey) throw new HttpError(503, "Flight search isn't connected yet. The owner needs to add a Duffel key.");
    return call(DUFFEL + path, { ...opt, headers: { Authorization: "Bearer " + duffelKey, "Duffel-Version": "v2" } });
  };
  const lite = (base, path, opt = {}) => {
    if (!liteKey) throw new HttpError(503, "Hotel search isn't connected yet. The owner needs to add a liteAPI key.");
    return call(base + path, { ...opt, headers: { "X-API-Key": liteKey } });
  };

  /* ---------- pricing (owner's exchange rates + service fee) ---------- */
  const cfg = () => (D.docs["site/config"] && D.docs["site/config"].data) || {};
  function toInr(amount, currency, kind) {
    const t = cfg().travel || {};
    const rate = currency === "INR" ? 1 : Number((t.fx || {})[currency]);
    if (!(rate > 0)) return null;
    const base = Math.ceil(Number(amount) * rate);
    const feePct = Number(kind === "flight" ? t.flightFeePct : t.hotelFeePct) || 0;
    const fee = Math.ceil(base * feePct / 100);
    return { base, fee, total: base + fee, rate, feePct, providerAmount: Number(amount), providerCurrency: currency };
  }

  /* ---------- flights (Duffel) ---------- */
  function normOffer(o, cabin) {
    const seg0 = (o.slices[0] && o.slices[0].segments[0]) || {};
    const pax0 = (seg0.passengers && seg0.passengers[0]) || {};
    return {
      id: o.id, kind: "flight", expiresAt: o.expires_at,
      airline: (o.owner && o.owner.name) || "Airline", airlineCode: (o.owner && o.owner.iata_code) || "",
      amount: Number(o.total_amount), amountText: String(o.total_amount), currency: o.total_currency,
      cabin: pax0.cabin_class_marketing_name || cabin || "Economy",
      baggage: (pax0.baggages || []).map(b => `${b.quantity} × ${String(b.type).replace(/_/g, " ")}`).join(", ") || "Check with airline",
      refundable: !!(o.conditions && o.conditions.refund_before_departure && o.conditions.refund_before_departure.allowed),
      changeable: !!(o.conditions && o.conditions.change_before_departure && o.conditions.change_before_departure.allowed),
      passengers: (o.passengers || []).map(p => ({ id: p.id, type: p.type || (p.age != null && p.age < 12 ? "child" : "adult") })),
      slices: o.slices.map(s => ({
        from: s.origin.iata_code, fromCity: s.origin.city_name || s.origin.name, to: s.destination.iata_code, toCity: s.destination.city_name || s.destination.name,
        fromTz: (s.origin && s.origin.time_zone) || "", toTz: (s.destination && s.destination.time_zone) || "", departAt: s.segments[0].departing_at, arriveAt: s.segments[s.segments.length - 1].arriving_at,
        minutes: minutes(s.duration), stops: s.segments.length - 1,
        flights: s.segments.map(g => `${(g.marketing_carrier && g.marketing_carrier.iata_code) || ""}${g.marketing_carrier_flight_number || ""}`)
      }))
    };
  }
  function priced(o) { const p = toInr(o.amount, o.currency, "flight"); return { ...o, price: p }; }

  async function places(q) {
    q = String(q || "").trim();
    if (q.length < 2) return [];
    const r = await duffel("/places/suggestions?query=" + encodeURIComponent(q));
    return (r.data || []).slice(0, 8).map(p => ({ code: p.iata_code, name: p.name, city: p.city_name || (p.city && p.city.name) || "", type: p.type }));
  }

  async function searchFlights(b) {
    const from = String(b.from || "").toUpperCase(), to = String(b.to || "").toUpperCase();
    if (!IATA.test(from) || !IATA.test(to)) throw bad("Choose departure and arrival airports from the list.");
    if (from === to) throw bad("Departure and arrival airports must be different.");
    if (!ISO.test(b.date || "") || b.date < todayISO()) throw bad("Choose a departure date from today onwards.");
    if (b.date > addDays(todayISO(), 330)) throw bad("Airlines sell seats up to about 11 months ahead. Choose an earlier date.");
    if (b.returnDate && (!ISO.test(b.returnDate) || b.returnDate < b.date)) throw bad("The return date must be on or after the departure date.");
    const adults = Math.round(Number(b.adults) || 1), children = Math.round(Number(b.children) || 0), infants = Math.round(Number(b.infants) || 0);
    if (adults < 1 || adults > 9 || children < 0 || infants < 0 || adults + children > 9) throw bad("Between 1 and 9 seats per booking, with at least one adult.");
    if (infants > adults) throw bad("Each infant needs an adult to travel with.");
    const cabin = ["economy", "premium_economy", "business", "first"].includes(b.cabin) ? b.cabin : "economy";
    const slices = [{ origin: from, destination: to, departure_date: b.date }];
    if (b.returnDate) slices.push({ origin: to, destination: from, departure_date: b.returnDate });
    const passengers = [...Array(adults)].map(() => ({ type: "adult" })).concat([...Array(children)].map(() => ({ age: 8 })), [...Array(infants)].map(() => ({ age: 1 })));
    const r = await duffel("/air/offer_requests?return_offers=true&supplier_timeout=20000", { method: "POST", body: { data: { slices, passengers, cabin_class: cabin } }, timeoutMs: 40000 });
    const offers = ((r.data && r.data.offers) || []).map(o => normOffer(o, cabin)).map(priced);
    offers.forEach(o => remember(o.id, { ...o, search: { from, to, date: b.date, returnDate: b.returnDate || "", adults, children, infants, cabin } }));
    const usable = offers.filter(o => o.price);
    const missing = [...new Set(offers.filter(o => !o.price).map(o => o.currency))];
    usable.sort((a, c) => a.price.total - c.price.total);
    return { offers: usable.slice(0, 50), total: usable.length, missingRates: missing };
  }

  /* ---------- hotels (liteAPI) ---------- */
  async function searchHotels(b) {
    const city = String(b.city || "").trim(), country = String(b.countryCode || "IN").toUpperCase();
    if (city.length < 2) throw bad("Enter a city.");
    if (!/^[A-Z]{2}$/.test(country)) throw bad("Choose a country.");
    if (!ISO.test(b.checkin || "") || b.checkin < todayISO()) throw bad("Choose a check-in date from today onwards.");
    if (!ISO.test(b.checkout || "") || b.checkout <= b.checkin) throw bad("Check-out must be after check-in.");
    const nights = Math.round((Date.parse(b.checkout) - Date.parse(b.checkin)) / 864e5);
    if (nights > 30) throw bad("Hotel stays can be up to 30 nights per booking.");
    const rooms = Math.round(Number(b.rooms) || 1), adults = Math.round(Number(b.adults) || 2);
    if (rooms < 1 || rooms > 5) throw bad("Between 1 and 5 rooms per booking.");
    if (adults < rooms || adults > rooms * 4) throw bad("Each room needs 1 to 4 adults.");
    const per = Math.floor(adults / rooms), extra = adults % rooms;
    const occupancies = [...Array(rooms)].map((_, i) => ({ adults: per + (i < extra ? 1 : 0) }));
    const r = await lite(LITE_SEARCH, "/hotels/rates", { method: "POST", body: { cityName: city, countryCode: country, checkin: b.checkin, checkout: b.checkout, currency: "INR", guestNationality: "IN", occupancies, limit: 40, timeout: 10, maxRatesPerHotel: 4, includeHotelData: true }, timeoutMs: 30000 });
    const info = new Map((r.hotels || []).map(h => [h.id, h]));
    const hotels = (r.data || []).map(h => {
      const hi = info.get(h.hotelId) || {};
      const rates = (h.roomTypes || []).map(rt => {
        const rate = (rt.rates || [])[0] || {};
        const orr = Array.isArray(rt.offerRetailRate) ? rt.offerRetailRate[0] : rt.offerRetailRate;
        const tot = (orr && orr.amount != null ? orr : ((rate.retailRate && rate.retailRate.total) || [])[0]) || {};
        const p = toInr(tot.amount, tot.currency || "INR", "hotel");
        const o = { id: rt.offerId, kind: "hotel", hotelId: h.hotelId, hotel: hi.name || "Hotel", room: rate.name || rt.name || "Room", board: rate.boardName || "", refundable: rate.cancellationPolicies && rate.cancellationPolicies.refundableTag === "RFN", amount: Number(tot.amount), currency: tot.currency || "INR", price: p, nights, rooms, adults, checkin: b.checkin, checkout: b.checkout, city, photo: hi.thumbnail || hi.main_photo || "", stars: hi.stars || null, rating: hi.rating || null, address: hi.address || "" };
        remember(o.id, o);
        return o;
      }).filter(o => o.id && o.price && o.amount > 0).sort((a, c) => a.price.total - c.price.total);
      return { hotelId: h.hotelId, name: hi.name || "Hotel", address: hi.address || "", stars: hi.stars || null, rating: hi.rating || null, photo: hi.thumbnail || hi.main_photo || "", rates, from: rates[0] ? rates[0].price.total : null };
    }).filter(h => h.rates.length).sort((a, c) => a.from - c.from);
    return { hotels, nights, total: hotels.length };
  }

  /* ---------- bookings (server-only document travel/<uid>) ---------- */
  const docOf = uid => (D.docs["travel/" + uid] && D.docs["travel/" + uid].data) || { bookings: {} };
  const getBooking = (uid, id) => { const b = docOf(uid).bookings[id]; if (!b) throw new HttpError(404, "Booking not found"); return b; };
  function save(uid, id, patch, note) {
    const cur = D.docs["travel/" + uid];
    const at = Date.now();
    const p = { bookings: { [id]: { ...patch, updatedAt: at, ...(note ? { history: { [at]: note } } : {}) } } };
    D.docs["travel/" + uid] = { data: cur ? deepMerge(cur.data, p) : p, version: (cur ? cur.version : 0) + 1, updatedAt: at, by: "system" };
    store.save(); changed("travel/" + uid);
    return docOf(uid).bookings[id];
  }
  const newRef = kind => (kind === "flight" ? "FL-" : "HT-") + todayISO().replace(/-/g, "").slice(2) + "-" + crypto.randomBytes(2).toString("hex").toUpperCase();

  function validateFlightPassengers(list, offer) {
    if (!Array.isArray(list) || list.length !== offer.passengers.length) throw bad(`Enter details for all ${offer.passengers.length} passenger(s).`);
    const dep = offer.slices[0].departAt.slice(0, 10);
    return list.map((p, i) => {
      const op = offer.passengers[i];
      const given = String(p.given_name || "").trim(), family = String(p.family_name || "").trim();
      if (!/^[A-Za-z][A-Za-z .'-]{0,39}$/.test(given) || !/^[A-Za-z][A-Za-z .'-]{0,39}$/.test(family)) throw bad(`Passenger ${i + 1}: enter first and last name exactly as on the ID, in English letters.`);
      if (!["mr", "ms", "mrs", "miss", "dr"].includes(p.title)) throw bad(`Passenger ${i + 1}: choose a title.`);
      if (!["m", "f"].includes(p.gender)) throw bad(`Passenger ${i + 1}: choose gender as on the ID.`);
      if (!ISO.test(p.born_on || "") || p.born_on >= todayISO()) throw bad(`Passenger ${i + 1}: enter a valid date of birth.`);
      const age = ageOn(p.born_on, dep);
      if (op.type === "adult" && age < 12) throw bad(`Passenger ${i + 1} is booked as an adult but is ${age} on the travel date.`);
      if (op.type !== "adult" && age >= 12) throw bad(`Passenger ${i + 1} is booked as a child but is ${age} on the travel date.`);
      const email = String(p.email || "").trim(), phone = String(p.phone_number || "").replace(/\s/g, "");
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) throw bad(`Passenger ${i + 1}: enter a valid email.`);
      if (!E164.test(phone)) throw bad(`Passenger ${i + 1}: enter the phone with country code, e.g. +919876543210.`);
      return { id: op.id, type: op.type, title: p.title, given_name: given, family_name: family, gender: p.gender, born_on: p.born_on, email, phone_number: phone };
    });
  }
  function validateHotelGuests(g, offer) {
    const h = g && g.holder || {};
    const first = String(h.firstName || "").trim(), last = String(h.lastName || "").trim(), email = String(h.email || "").trim(), phone = String(h.phone || "").replace(/\s/g, "");
    if (!first || !last) throw bad("Enter the lead guest's first and last name.");
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) throw bad("Enter a valid email for the hotel voucher.");
    if (!E164.test(phone)) throw bad("Enter the phone with country code, e.g. +919876543210.");
    const holder = { firstName: first, lastName: last, email, phone };
    const guests = [...Array(offer.rooms)].map((_, i) => ({ occupancyNumber: i + 1, firstName: first, lastName: last, email }));
    return { holder, guests };
  }

  /* Step: revalidate price + availability with the provider, create the pending booking. */
  async function hold(uid, b) {
    const offer = recall(String(b.offerId || ""));
    if (!offer) throw new HttpError(409, "This option has expired. Please search again.");
    const id = "t" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
    let booking;
    if (offer.kind === "flight") {
      const passengers = validateFlightPassengers(b.passengers, offer);
      const fresh = normOffer((await duffel("/air/offers/" + encodeURIComponent(offer.id) + "?return_available_services=false")).data, offer.cabin);
      if (fresh.expiresAt && Date.parse(fresh.expiresAt) < Date.now()) throw new HttpError(409, "This fare has expired. Please search again.");
      const price = toInr(fresh.amount, fresh.currency, "flight");
      if (!price) throw new HttpError(409, `Prices in ${fresh.currency} can't be shown yet. The owner needs to set an exchange rate.`);
      const s0 = fresh.slices[0], s1 = fresh.slices[1];
      booking = { id, ref: newRef("flight"), kind: "flight", status: "awaiting_payment", provider: "duffel", offerId: offer.id, offer: fresh, passengers, price,
        priceChanged: fresh.amount !== offer.amount || fresh.currency !== offer.currency, quotedTotal: offer.price ? offer.price.total : null,
        title: `${fresh.airline} · ${s0.fromCity} → ${s0.toCity}${s1 ? " (return)" : ""}`, travelDate: s0.departAt.slice(0, 10), endDate: (s1 || s0).arriveAt.slice(0, 10), expiresAt: fresh.expiresAt, createdAt: Date.now() };
    } else {
      const g = validateHotelGuests(b, offer);
      const pre = (await lite(LITE_BOOK, "/rates/prebook", { method: "POST", body: { offerId: offer.id, usePaymentSdk: false } })).data || {};
      if (!pre.prebookId) throw new HttpError(409, "This room is no longer available. Please choose another.");
      const price = toInr(pre.price, pre.currency || "INR", "hotel");
      if (!price) throw new HttpError(409, "This room's currency isn't supported yet.");
      booking = { id, ref: newRef("hotel"), kind: "hotel", status: "awaiting_payment", provider: "liteapi", offerId: offer.id, prebookId: pre.prebookId, offer, holder: g.holder, guests: g.guests, price,
        priceChanged: Number(pre.price) !== offer.amount || !!pre.priceDifferencePercent, policyChanged: !!pre.cancellationChanged || !!pre.boardChanged, quotedTotal: offer.price ? offer.price.total : null,
        title: `${offer.hotel} · ${offer.room}`, travelDate: offer.checkin, endDate: offer.checkout, expiresAt: new Date(Date.now() + 20 * 60e3).toISOString(), createdAt: Date.now() };
    }
    if (Object.values(docOf(uid).bookings).filter(x => x.status === "awaiting_payment").length >= 5) throw new HttpError(429, "You have 5 unpaid flight/hotel holds. Pay or let one expire first.");
    save(uid, id, booking, booking.priceChanged ? `Price re-checked: changed to ₹${booking.price.total}` : `Price re-checked: ₹${booking.price.total} confirmed`);
    return docOf(uid).bookings[id];
  }

  async function startPayment(uid, id) {
    const b = getBooking(uid, id);
    if (b.status !== "awaiting_payment") throw new HttpError(409, "This booking isn't waiting for payment.");
    if (b.expiresAt && Date.parse(b.expiresAt) < Date.now()) { save(uid, id, { status: "expired" }, "Hold expired before payment"); throw new HttpError(409, "This price hold has expired. Please search again for a fresh price."); }
    return pay.createTravelOrder(uid, b);
  }

  /* Called once Razorpay confirms the money. Books with the provider; refunds in full if that fails. */
  async function onPaid(rec) {
    const uid = rec.uid, id = rec.bookingId;
    const b = docOf(uid).bookings[id];
    if (!b || ["confirming", "confirmed"].includes(b.status)) return;
    save(uid, id, { status: "confirming", payment: { orderId: rec.orderIdRef || null, paymentId: rec.paymentId, amount: rec.amount / 100, at: rec.paidAt } }, `Payment received ₹${rec.amount / 100}; confirming with ${b.provider === "duffel" ? "the airline" : "the hotel"}`);
    const orderId = Object.keys(D.payments).find(k => D.payments[k] === rec);
    try {
      let confirm;
      if (b.kind === "flight") {
        const o = (await duffel("/air/orders", { method: "POST", body: { data: { type: "instant", selected_offers: [b.offerId], payments: [{ type: "balance", currency: b.offer.currency, amount: b.offer.amountText || String(b.offer.amount) }], passengers: b.passengers } }, timeoutMs: 60000 })).data;
        confirm = { providerOrderId: o.id, reference: o.booking_reference };
      } else {
        const r = (await lite(LITE_BOOK, "/rates/book", { method: "POST", body: { prebookId: b.prebookId, clientReference: b.id, holder: b.holder, guests: b.guests, payment: { method: litePayment } }, timeoutMs: 60000 })).data || {};
        if (r.status && r.status !== "CONFIRMED") throw new Error("Hotel did not confirm (" + r.status + ")");
        confirm = { providerOrderId: r.bookingId, reference: r.hotelConfirmationCode || r.bookingId };
      }
      save(uid, id, { status: "confirmed", ...confirm, confirmedAt: Date.now(), paymentOrderId: orderId, invoiceNo: "INV-" + b.ref }, `Confirmed by ${b.kind === "flight" ? "airline" : "hotel"}: ${confirm.reference}`);
    } catch (e) {
      console.error("[travel confirm]", e.message);
      let refunded = 0;
      try { refunded = (await pay.refundOrder(orderId, rec.amount, "Provider could not confirm")).refunded; } catch (re) { console.error("[travel refund]", re.message); }
      save(uid, id, { status: refunded ? "failed_refunded" : "failed_refund_pending", failure: String(e.message || "Provider error").slice(0, 200), refund: { amount: refunded, at: Date.now() }, paymentOrderId: orderId },
        refunded ? `Provider couldn't confirm; ₹${refunded} refunded automatically` : "Provider couldn't confirm; refund pending — owner alerted");
    }
  }
  pay.onTravelPaid = onPaid;

  /* Cancellation: quote first (customer sees the refund), then confirm. */
  async function cancelQuote(uid, id) {
    const b = getBooking(uid, id);
    if (b.status === "awaiting_payment") { save(uid, id, { status: "cancelled" }, "Hold cancelled by customer before payment"); return { cancelled: true, refund: 0 }; }
    if (b.status !== "confirmed") throw new HttpError(409, "Only confirmed bookings can be cancelled.");
    if (b.travelDate <= todayISO()) throw new HttpError(409, "This trip has started. Please contact support.");
    if (b.kind === "flight") {
      const q = (await duffel("/air/order_cancellations", { method: "POST", body: { data: { order_id: b.providerOrderId } } })).data;
      const inr = toInr(q.refund_amount, q.refund_currency, "flight");
      const refund = Math.min(b.price.total, inr ? inr.base : 0);
      save(uid, id, { cancelQuote: { id: q.id, refund, providerRefund: Number(q.refund_amount), currency: q.refund_currency, expiresAt: q.expires_at } }, `Cancellation quote: ₹${refund} back`);
      return { refund, expiresAt: q.expires_at, feeNote: b.price.fee ? `Service fee ₹${b.price.fee} isn't refundable.` : "" };
    }
    const refund = b.offer.refundable ? b.price.base : 0;
    save(uid, id, { cancelQuote: { id: "lite", refund } }, `Cancellation quote: ${b.offer.refundable ? "refundable rate" : "non-refundable rate"}`);
    return { refund, nonRefundable: !b.offer.refundable, feeNote: b.price.fee ? `Service fee ₹${b.price.fee} isn't refundable.` : "" };
  }
  async function cancelConfirm(uid, id) {
    const b = getBooking(uid, id);
    if (b.status !== "confirmed" || !b.cancelQuote) throw new HttpError(409, "Get a cancellation quote first.");
    let refundInr;
    if (b.kind === "flight") {
      if (b.cancelQuote.expiresAt && Date.parse(b.cancelQuote.expiresAt) < Date.now()) throw new HttpError(409, "The cancellation quote expired. Please request it again.");
      await duffel("/air/order_cancellations/" + encodeURIComponent(b.cancelQuote.id) + "/actions/confirm", { method: "POST" });
      refundInr = b.cancelQuote.refund;
    } else {
      const r = (await lite(LITE_BOOK, "/bookings/" + encodeURIComponent(b.providerOrderId), { method: "PUT" })).data || {};
      const inr = toInr(r.refund_amount || 0, r.currency || "INR", "hotel");
      refundInr = Math.min(b.price.base, inr ? inr.base : 0);
    }
    let refunded = 0, refundId = null;
    if (refundInr > 0 && b.paymentOrderId) { const rr = await pay.refundOrder(b.paymentOrderId, refundInr * 100, "Customer cancellation"); refunded = rr.refunded; refundId = rr.refundId || null; }
    save(uid, id, { status: "cancelled", cancelledAt: Date.now(), refund: { amount: refunded, at: Date.now(), id: refundId } }, refunded ? `Cancelled; ₹${refunded} refunded` : "Cancelled; no refund due under the fare rules");
    return { refunded };
  }

  /* Reconciliation (owner): retry a refund that failed earlier. Never re-books and never charges again. */
  async function retryRefund(uid, id) {
    const b = getBooking(uid, id);
    if (b.status !== "failed_refund_pending") throw new HttpError(409, "This booking has no pending refund.");
    if (!b.paymentOrderId) throw new HttpError(409, "No payment is linked to this booking.");
    const r = await pay.refundOrder(b.paymentOrderId, Math.round((b.payment ? b.payment.amount : b.price.total) * 100), "Provider could not confirm (retry)");
    save(uid, id, { status: "failed_refunded", refund: { amount: r.refunded, at: Date.now(), id: r.refundId || null } }, `Refund of ₹${r.refunded} issued by the owner`);
    return { refunded: r.refunded };
  }
  /* Bookings that need a person: refunds pending, or paid but unconfirmed for over 15 minutes. */
  function attention() {
    const out = [];
    for (const [k, d] of Object.entries(D.docs)) {
      if (!k.startsWith("travel/")) continue;
      for (const b of Object.values((d.data && d.data.bookings) || {})) {
        if (b.status === "failed_refund_pending") out.push({ uid: k.slice(7), id: b.id, ref: b.ref, why: "Refund pending" });
        else if (b.status === "confirming" && Date.now() - (b.updatedAt || 0) > 15 * 60e3) out.push({ uid: k.slice(7), id: b.id, ref: b.ref, why: "Paid, provider hasn't confirmed for 15+ minutes" });
      }
    }
    return out;
  }

  function invoiceHtml(uid, id) {
    const b = getBooking(uid, id), c = cfg(), u = D.users[uid] || {};
    if (!["confirmed", "cancelled"].includes(b.status) || !b.invoiceNo) throw new HttpError(409, "An invoice is available once the booking is confirmed.");
    const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
    const inr = n => "₹" + Number(n || 0).toLocaleString("en-IN");
    const lines = b.kind === "flight"
      ? b.offer.slices.map(s => `<tr><td>${esc(s.fromCity)} (${esc(s.from)}) → ${esc(s.toCity)} (${esc(s.to)})<br><small>${esc(s.flights.join(", "))} · ${esc(s.departAt.replace("T", " ").slice(0, 16))}</small></td><td>${b.passengers.length} pax</td></tr>`).join("")
      : `<tr><td>${esc(b.offer.hotel)} — ${esc(b.offer.room)}<br><small>${esc(b.offer.checkin)} to ${esc(b.offer.checkout)} · ${b.offer.nights} night(s) · ${b.offer.rooms} room(s)</small></td><td>${esc(b.offer.board)}</td></tr>`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Invoice ${esc(b.invoiceNo)}</title><style>body{font:14px/1.5 system-ui,sans-serif;color:#0F2A2E;max-width:760px;margin:32px auto;padding:0 16px}h1{font-size:22px;margin:0}table{width:100%;border-collapse:collapse;margin:16px 0}td,th{padding:8px;border-bottom:1px solid #D3DCD9;text-align:left;vertical-align:top}.r{text-align:right}.muted{color:#56696A}.tot td{font-weight:700}button{padding:8px 16px;border-radius:20px;border:1px solid #0F2A2E;background:#fff;cursor:pointer}@media print{button{display:none}}</style></head><body>
<div style="display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap"><div><h1>${esc(c.name || "Sashwanth Travels")}</h1><div class="muted">${esc(c.address || "")}<br>${esc(c.phone || "")} ${esc(c.email || "")}</div></div><div class="r"><b>Invoice ${esc(b.invoiceNo)}</b><br>Date: ${new Date(b.confirmedAt || b.createdAt).toLocaleDateString("en-IN")}<br>Booking: ${esc(b.ref)}<br>${b.kind === "flight" ? "Airline PNR" : "Hotel ref"}: ${esc(b.reference || "-")}</div></div>
<p><b>Billed to:</b> ${esc(u.name)} · ${esc(u.email)} · ${esc(u.phone)}</p>
<table><tr><th>${b.kind === "flight" ? "Flight" : "Stay"}</th><th></th></tr>${lines}</table>
<table><tr><td>${b.kind === "flight" ? "Fare" : "Room charges"} (${esc(b.price.providerCurrency)} ${b.price.providerAmount}${b.price.providerCurrency !== "INR" ? ` @ ₹${b.price.rate}` : ""})</td><td class="r">${inr(b.price.base)}</td></tr>${b.price.fee ? `<tr><td>Service fee (${b.price.feePct}%)</td><td class="r">${inr(b.price.fee)}</td></tr>` : ""}<tr class="tot"><td>Total paid</td><td class="r">${inr(b.price.total)}</td></tr>${b.refund && b.refund.amount ? `<tr><td>Refunded</td><td class="r">− ${inr(b.refund.amount)}</td></tr>` : ""}</table>
<p class="muted">Payment ${esc((b.payment && b.payment.paymentId) || "")} via Razorpay. Status: ${esc(b.status)}.</p><button onclick="print()">Print / Save as PDF</button></body></html>`;
  }

  return { enabled: { flights: !!duffelKey, hotels: !!liteKey, test: /^duffel_test_/.test(duffelKey || "") || /^sand_/.test(liteKey || "") }, places, searchFlights, searchHotels, hold, startPayment, cancelQuote, cancelConfirm, invoiceHtml, onPaid, getBooking, retryRefund, attention };
}

module.exports = { createTravel, minutes, ageOn };
