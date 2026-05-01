"use client"

import { useEffect, useMemo, useRef, useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import { createPortal } from "react-dom"
import { useAuth } from "@/lib/auth-context"
import CubeLoader from "@/components/ui/cube-loader"
import FullCalendar from "@fullcalendar/react"
import dayGridPlugin from "@fullcalendar/daygrid"
import timeGridPlugin from "@fullcalendar/timegrid"
import listPlugin from "@fullcalendar/list"
import interactionPlugin from "@fullcalendar/interaction"
import { formatDate } from "@fullcalendar/core"
import type { DateSelectArg, EventClickArg, EventDropArg, EventInput } from "@fullcalendar/core"
import { WINBROS_CALENDAR_ADDONS, WINDOW_TIERS, type WindowTier } from "@/lib/pricebook"
import { KNOWN_LEAD_SOURCES } from "@/lib/lead-sources"
import ScheduleGantt, { type GanttJob } from "@/components/dashboard/schedule-gantt"
import { DollarSign, CreditCard, FileText, KeyRound, Zap, Copy, Check, Send, Loader2, Plus } from "lucide-react"
import { StripeCardForm } from "@/components/stripe-card-form"
import { JobDetailDrawer } from "@/components/winbros/job-detail-drawer"
import { QuoteBuilderSheet } from "@/components/winbros/quote-builder-sheet"
import { useStartNewQuote } from "@/hooks/use-start-new-quote"
import "./calendar.css"

type CalendarJob = {
  id: string | number
  title?: string
  service_type?: string
  date?: string
  scheduled_at?: string
  scheduled_time?: string
  scheduled_date?: string
  hours?: number
  price?: number
  estimated_value?: number
  status?: string
  notes?: string
  address?: string
  phone_number?: string
  customer_name?: string
  customers?: any
  cleaners?: any
  cleaner_id?: number
  cleaner_assignments?: any[]
  teams?: any
  frequency?: string
  parent_job_id?: number | null
  membership_id?: string | null
  leads?: { source: string }[]
  credited_salesman_id?: number | null
  credited_salesman?: { id: number; name: string } | null
}

type CalendarEventDetails = {
  jobId: string
  title: string
  start: Date | null
  end: Date | null
  location: string
  description: string
  status: string
  price: number
  client: string
  cleaner: string
  cleanerName: string
  cleanerId: string
  team: string
  service: string
  notes: string
  hours: number
  cardOnFile: boolean
  frequency: string
  parentJobId: string | null
  jobType: string
  leadSource: string
  customerPhone: string
  customerEmail: string
  customerId: string
  salesmanName: string
}

type PendingMove = {
  jobId: string
  newStart: Date
  newEnd: Date
  hours: number
  cleanerName: string
  conflictJobId: string
  conflictTitle: string
  conflictStart: Date
  conflictEnd: Date
  conflictHours: number
  revert: (() => void) | null
  source: "drag" | "edit"
}

type AddonOption = {
  addon_key: string
  label: string
  flat_price: number | null
  minutes: number
}

type AssignmentMode = "auto_broadcast" | "ranked" | "unassigned" | "specific"

type CreateForm = {
  customer_phone: string
  customer_name: string
  email: string
  address: string
  service_type: string
  date: string
  time: string
  duration_minutes: string
  price: string
  notes: string
  bedrooms: string
  bathrooms: string
  sqft: string
  frequency: string
  cleaner_ids: string[]
  cleaner_count: string
  assignment_mode: AssignmentMode
  is_quote: boolean
  selected_addons: string[]
  membership_id: string
  selected_tier_index: string
  lead_source: string
  credited_salesman_id: string
}

type CustomerMembership = {
  id: string
  status: string
  visits_completed: number
  service_plans: {
    name: string
    slug: string
    visits_per_year: number
    discount_per_visit: number
  }
}

type ServicePlan = {
  id: string
  name: string
  slug: string
  visits_per_year: number
  interval_months: number
  discount_per_visit: number
}

type RainDayPreview = {
  date: string
  jobs_count: number
  total_revenue: number
  jobs: { id: string; customer_name: string; time: string; value: number; address: string }[]
}

type RainDayResult = {
  jobs_affected: number
  jobs_successfully_rescheduled: number
  notifications_sent: number
  spread_summary: Record<string, number>
}

const CLEANER_COLORS = [
  "#3b82f6", // blue
  "#22c55e", // green
  "#ef4444", // red
  "#f97316", // orange
  "#a855f7", // purple
  "#14b8a6", // teal
  "#ec4899", // pink
  "#eab308", // yellow
  "#6366f1", // indigo
  "#06b6d4", // cyan
]

const LEAD_SOURCE_CONFIG: Record<string, { label: string; color: string }> = {
  phone: { label: "Phone", color: "#5b8def" },
  vapi: { label: "Vapi", color: "#7ca3f0" },
  meta: { label: "Meta", color: "#4ade80" },
  website: { label: "Website", color: "#facc15" },
  sms: { label: "SMS", color: "#f472b6" },
  housecall_pro: { label: "HCP", color: "#a78bfa" },
  ghl: { label: "GHL", color: "#fb923c" },
  manual: { label: "Manual", color: "#94a3b8" },
}

function getLeadSourceConfig(source: string) {
  return LEAD_SOURCE_CONFIG[source] || { label: source, color: "#6b7280" }
}

const emptyValue = "\u2014"

function resolveCustomer(job: CalendarJob) {
  if (Array.isArray(job.customers)) {
    return job.customers[0]
  }
  return job.customers || null
}

function resolveCustomerName(job: CalendarJob) {
  if (job.customer_name) return job.customer_name
  const customer = resolveCustomer(job)
  if (customer && typeof customer.name === "string" && customer.name.trim()) {
    return customer.name
  }
  const first = customer?.first_name ? String(customer.first_name).trim() : ""
  const last = customer?.last_name ? String(customer.last_name).trim() : ""
  const combined = `${first} ${last}`.trim()
  return combined || "Unknown"
}

function resolveLocation(job: CalendarJob) {
  const customer = resolveCustomer(job)
  return job.address || customer?.address || job.service_type || ""
}

function humanizeServiceType(value: string | undefined): string {
  if (!value) return ""
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim()
}

function resolveServiceLabel(job: CalendarJob): string {
  return humanizeServiceType(job.service_type) || ""
}

function resolveTeamName(job: CalendarJob): string {
  const team = job.teams
  if (!team) return ""
  if (Array.isArray(team)) return team[0]?.name || ""
  return team.name || ""
}

function resolveNotes(job: CalendarJob): string {
  const notes = job.notes
  if (!notes) return ""
  // Strip internal tags and format for display
  const lines = notes.split('\n').map(l => l.trim()).filter(Boolean)
  const cleaned: string[] = []
  for (const line of lines) {
    const lower = line.toLowerCase()
    // Skip internal override tags, payment notes, emails
    if (lower.startsWith('override:')) continue
    if (lower.startsWith('hours:') || lower.startsWith('pay:') || lower.startsWith('payment:')) continue
    if (lower.includes('invoice_url') || lower.includes('@')) continue
    // Format frequency nicely
    if (lower.startsWith('frequency:')) {
      const freq = line.split(':')[1]?.trim().replace(/_/g, ' ')
      if (freq) cleaned.push(`Frequency: ${freq.charAt(0).toUpperCase() + freq.slice(1)}`)
      continue
    }
    // Filter out all-caps system notes
    if (/^[A-Z0-9_|\s]+$/.test(line.trim())) continue
    cleaned.push(line)
  }
  return cleaned.join(' | ')
}

function resolveCleanerFromAssignments(job: CalendarJob): { id: string; name: string } | null {
  const assignments = job.cleaner_assignments
  if (!Array.isArray(assignments) || assignments.length === 0) return null
  const confirmed = assignments.find((a: any) => a.status === "confirmed")
    || assignments.find((a: any) => a.status === "accepted")
    || assignments.find((a: any) => a.status === "pending")
    || null
  if (!confirmed) return null
  const c = Array.isArray(confirmed.cleaners) ? confirmed.cleaners[0] : confirmed.cleaners
  if (!c) return null
  return { id: String(c.id), name: c.name || "Unknown" }
}

function resolveCleanerName(job: CalendarJob) {
  const cleaner = job.cleaners
  if (cleaner) {
    if (Array.isArray(cleaner)) return cleaner[0]?.name || null
    return cleaner.name || null
  }
  return resolveCleanerFromAssignments(job)?.name || null
}

function resolveCleanerId(job: CalendarJob): string {
  const cleaner = job.cleaners
  if (cleaner) {
    const c = Array.isArray(cleaner) ? cleaner[0] : cleaner
    return c?.id ? String(c.id) : ""
  }
  return resolveCleanerFromAssignments(job)?.id || ""
}

function resolveLeadSource(job: CalendarJob): string {
  if (job.leads && Array.isArray(job.leads) && job.leads.length > 0) {
    return job.leads[0].source || ""
  }
  return ""
}

function resolveSalesmanName(job: CalendarJob): string {
  if (job.credited_salesman) {
    const s = Array.isArray(job.credited_salesman) ? job.credited_salesman[0] : job.credited_salesman
    return s?.name || ""
  }
  return ""
}

function resolveStart(job: CalendarJob) {
  // date column is the actual date (YYYY-MM-DD), scheduled_at is a time string
  const dateStr = job.date || job.scheduled_date
  if (!dateStr) return new Date()

  const rawDate = String(dateStr)

  // If it's already a full ISO timestamp, use it directly
  if (rawDate.includes("T")) return new Date(rawDate)

  // Use scheduled_at as the time component (e.g. "09:00 AM PST", "14:30", "4:00 PM", etc.)
  const timeStr = String(job.scheduled_at || job.scheduled_time || "")

  // Handle 12-hour format: "4:00 PM", "10:30 AM", "4:00 PM PST"
  const twelveHrMatch = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i)
  if (twelveHrMatch) {
    let hours = parseInt(twelveHrMatch[1], 10)
    const minutes = twelveHrMatch[2]
    const meridiem = twelveHrMatch[3].toUpperCase()
    if (meridiem === "PM" && hours !== 12) hours += 12
    if (meridiem === "AM" && hours === 12) hours = 0
    return new Date(`${rawDate}T${String(hours).padStart(2, "0")}:${minutes}:00`)
  }

  // Handle 24-hour format: "14:00", "09:00"
  const twentyFourHrMatch = timeStr.match(/^(\d{1,2}):(\d{2})/)
  if (twentyFourHrMatch) {
    const hh = String(parseInt(twentyFourHrMatch[1], 10)).padStart(2, "0")
    return new Date(`${rawDate}T${hh}:${twentyFourHrMatch[2]}:00`)
  }

  // Default to 9am
  return new Date(`${rawDate}T09:00:00`)
}

function resolveEnd(job: CalendarJob) {
  const start = resolveStart(job)
  const hours = job.hours ? Number(job.hours) : 2
  const end = new Date(start.getTime() + hours * 60 * 60 * 1000)
  // Cap end to same day so FullCalendar renders as dot event, not multi-day block
  if (end.getDate() !== start.getDate() || end.getMonth() !== start.getMonth()) {
    return new Date(start.getFullYear(), start.getMonth(), start.getDate(), 23, 59, 59)
  }
  return end
}

function formatRange(start: Date | null, end: Date | null) {
  if (!start) return ""
  const startLabel = formatDate(start, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
  if (!end) return startLabel
  const sameDay = start.toDateString() === end.toDateString()
  const endLabel = formatDate(
    end,
    sameDay
      ? { hour: "numeric", minute: "2-digit", hour12: true }
      : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }
  )
  return `${startLabel} \u2013 ${endLabel}`
}

function toLocalInput(date: Date | null) {
  if (!date) return ""
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function eventClassForStatus(status?: string) {
  switch (status) {
    case "completed": return "event-completed"
    case "cancelled": return "event-cancelled"
    case "in_progress": return "event-in-progress"
    case "rescheduled": return "event-rescheduled"
    case "pending": return "event-pending"
    default: return "event-scheduled"
  }
}

const STORAGE_KEY_VIEW = "calendar-view"
const STORAGE_KEY_DATE = "calendar-date"

function getSavedView(): string {
  if (typeof window === "undefined") return "timeGridWeek"
  const saved = localStorage.getItem(STORAGE_KEY_VIEW)
  if (saved && saved !== "gantt") return saved
  // Default to list view on mobile for better readability
  return window.innerWidth < 768 ? "listWeek" : "timeGridWeek"
}

function getSavedIsGantt(): boolean {
  if (typeof window === "undefined") return false
  return localStorage.getItem(STORAGE_KEY_VIEW) === "gantt"
}

function getSavedDate(): string | undefined {
  if (typeof window === "undefined") return undefined
  const saved = localStorage.getItem(STORAGE_KEY_DATE)
  if (!saved) return new Date().toISOString().split("T")[0]
  // If saved date is more than 1 day from today, snap to today
  const diff = Math.abs(Date.now() - new Date(saved).getTime())
  if (diff > 86_400_000) return new Date().toISOString().split("T")[0]
  return saved
}

export default function JobsPage() {
  const { user, isAdmin, isSalesman, isTeamLead, employeeType, cleanerId: authCleanerId, portalToken } = useAuth()
  const router = useRouter()
  const isFieldRole = !isAdmin && (employeeType === 'technician' || employeeType === 'salesman' || isTeamLead)
  // Anyone who can mint quotes gets the + New Quote popup — admins via
  // session auth, crew via portal token (commission-attributed). The clock
  // widget and salesman commission chip moved to /my-day Command Center
  // so /jobs is just the calendar.
  const showNewQuoteButton = isAdmin || (!!portalToken && (employeeType === 'salesman' || employeeType === 'technician' || isTeamLead))

  // FullCalendar drag-drop / event-drop is destructive — anyone who isn't
  // an admin or team-lead is view-only. Stops a salesman or tech from
  // accidentally rescheduling a job.
  const canEditCalendar = isAdmin || isTeamLead

  // Quote popup — kept on /jobs (no router.push). Locked by Playwright.
  const [quoteSheetId, setQuoteSheetId] = useState<string | null>(null)
  const { start: startNewQuoteRaw, creating: creatingQuoteDraft } = useStartNewQuote(portalToken)
  const startNewQuote = useCallback(async () => {
    const id = await startNewQuoteRaw()
    if (id) setQuoteSheetId(id)
  }, [startNewQuoteRaw])
  const isHouseCleaning = user?.tenantSlug !== "winbros"
  const [jobs, setJobs] = useState<CalendarJob[]>([])
  const [myCleanerId, setMyCleanerId] = useState<number | null>(null)
  const [crewMemberIds, setCrewMemberIds] = useState<number[]>([])
  const [loading, setLoading] = useState(true)
  const [jobServiceTypes, setJobServiceTypes] = useState<string[]>([])
  const [selectedEvent, setSelectedEvent] = useState<CalendarEventDetails | null>(null)
  const [drawerJobId, setDrawerJobId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const calendarRef = useRef<FullCalendar | null>(null)
  const [ganttView, setGanttView] = useState(getSavedIsGantt)
  const [activeFcView, setActiveFcView] = useState(getSavedView)
  const [hiddenCleaners, setHiddenCleaners] = useState<Set<string>>(new Set())
  const [createForm, setCreateForm] = useState<CreateForm>({
    customer_phone: "",
    customer_name: "",
    email: "",
    address: "",
    service_type: isHouseCleaning ? "Standard cleaning" : "Window cleaning",
    date: "",
    time: "",
    duration_minutes: "120",
    price: "",
    notes: "",
    bedrooms: "",
    bathrooms: "",
    sqft: "",
    frequency: "one-time",
    cleaner_ids: [],
    cleaner_count: "1",
    assignment_mode: "auto_broadcast" as AssignmentMode,
    is_quote: false,
    selected_addons: [],
    membership_id: "",
    selected_tier_index: "",
    lead_source: "",
    credited_salesman_id: "",
  })
  const [createSaving, setCreateSaving] = useState(false)
  const [createError, setCreateError] = useState("")
  const [quoteSuccess, setQuoteSuccess] = useState<{ url: string; token: string; quoteId?: string; sent: boolean; sending?: boolean; customerPhone?: string; customerId?: string } | null>(null)
  const [addonsList, setAddonsList] = useState<AddonOption[]>([])
  // Payment menu state (shared between quote success + event detail)
  const [pmOpen, setPmOpen] = useState(false)
  const [pmType, setPmType] = useState<string | null>(null)
  const [pmAmount, setPmAmount] = useState("")
  const [pmJobId, setPmJobId] = useState("")
  const [pmLoading, setPmLoading] = useState(false)
  const [pmResult, setPmResult] = useState<{ url?: string; invoiceId?: string } | null>(null)
  const [pmCopied, setPmCopied] = useState(false)
  const [pmSmsSent, setPmSmsSent] = useState(false)
  const [pmSmsSending, setPmSmsSending] = useState(false)
  const [pmChargeLoading, setPmChargeLoading] = useState(false)
  const [pmChargeResult, setPmChargeResult] = useState<{ success: boolean; amount?: number; error?: string } | null>(null)
  const [pmChargeDesc, setPmChargeDesc] = useState("")
  const [pmError, setPmError] = useState<string | null>(null)
  const [cardFormOpen, setCardFormOpen] = useState(false)
  const [pmPos, setPmPos] = useState<{ top: number; left: number } | null>(null)
  const pmRef = useRef<HTMLDivElement>(null)
  const pmBtnRef = useRef<HTMLButtonElement>(null)
  const [lookedUpCustomerId, setLookedUpCustomerId] = useState<string | null>(null)
  const [customerMemberships, setCustomerMemberships] = useState<CustomerMembership[]>([])
  const [servicePlans, setServicePlans] = useState<ServicePlan[]>([])
  // Add charge state (card-on-file tenants)
  const [addChargeOpen, setAddChargeOpen] = useState(false)
  const [addChargeType, setAddChargeType] = useState("")
  const [addChargeAmount, setAddChargeAmount] = useState("")
  const [addChargeDesc, setAddChargeDesc] = useState("")
  const [addChargeSaving, setAddChargeSaving] = useState(false)
  const [basePrice, setBasePrice] = useState<number>(0)
  const [baseLaborMinutes, setBaseLaborMinutes] = useState<number>(0)
  const [addressSuggestions, setAddressSuggestions] = useState<{ description: string; place_id: string }[]>([])
  const [showAddressSuggestions, setShowAddressSuggestions] = useState(false)
  const [phoneLookedUp, setPhoneLookedUp] = useState("")
  const [phoneSuggestions, setPhoneSuggestions] = useState<any[]>([])
  const [showPhoneSuggestions, setShowPhoneSuggestions] = useState(false)
  const [customerSearch, setCustomerSearch] = useState("")
  const [customerSearchResults, setCustomerSearchResults] = useState<any[]>([])
  const [showCustomerSearch, setShowCustomerSearch] = useState(false)
  const [isPreviewing, setIsPreviewing] = useState(false)
  // Refs for values read inside closures/timeouts to avoid stale captures
  const pendingJobOpenRef = useRef<string | null>(null)
  const isPreviewingRef = useRef(false)
  const formSnapshotRef = useRef<CreateForm | null>(null)
  const basePriceSnapshotRef = useRef<number>(0)
  const [windowTiers, setWindowTiers] = useState<WindowTier[]>(WINDOW_TIERS)

  // Auto-populate price when property details change (house cleaning only)
  useEffect(() => {
    if (!isHouseCleaning) return
    const { bedrooms, bathrooms, sqft, service_type } = createForm
    if (!bedrooms || !bathrooms) return

    const params = new URLSearchParams({
      bedrooms,
      bathrooms,
      service_type,
      ...(sqft ? { sqft } : {}),
    })

    let cancelled = false
    fetch(`/api/pricing/estimate?${params}`)
      .then((r) => r.json())
      .then((res) => {
        if (cancelled) return
        if (res.success && res.data?.price != null) {
          const base = Number(res.data.price)
          setBasePrice(base)
          // Add addon prices (skip addons included in the tier — their cost is in the base price)
          const st = (createForm.service_type || "").toLowerCase()
          const tierKey = st.includes("deep") ? "deep" : st.includes("move") ? "move" : "standard"
          const addonTotal = createForm.selected_addons.reduce((sum, key) => {
            const addon = addonsList.find((a) => a.addon_key === key)
            const dbInc = isHouseCleaning && Array.isArray((addon as any)?.included_in) && (addon as any).included_in.includes(tierKey)
            const codeInc = isHouseCleaning && (TIER_INCLUDED_ADDONS[tierKey] || []).includes(key)
            if (dbInc || codeInc) return sum
            return sum + (addon?.flat_price || 0)
          }, 0)
          // Auto-set duration and cleaner count from labor_hours
          const laborMins = res.data.labor_hours ? Math.round(Number(res.data.labor_hours) * 60) : 0
          const recCleaners = res.data.cleaners ? Number(res.data.cleaners) : 1
          setBaseLaborMinutes(laborMins)
          const addonMins = createForm.selected_addons.reduce((sum, key) => {
            const addon = addonsList.find((a) => a.addon_key === key)
            const dbInc = isHouseCleaning && Array.isArray((addon as any)?.included_in) && (addon as any).included_in.includes(tierKey)
            const codeInc = isHouseCleaning && (TIER_INCLUDED_ADDONS[tierKey] || []).includes(key)
            if (dbInc || codeInc) return sum // time already in base labor_hours
            return sum + (addon?.minutes || 0)
          }, 0)
          const wallMins = Math.ceil((laborMins + addonMins) / (recCleaners || 1))
          const snapped = [60, 90, 120, 150, 180, 240, 300, 360, 420, 480].find(v => v >= wallMins) || 480
          setCreateForm((prev) => ({ ...prev, price: String(base + addonTotal), duration_minutes: String(snapped), cleaner_count: String(recCleaners) }))
        }
      })
      .catch(() => {})

    return () => { cancelled = true }
  }, [createForm.bedrooms, createForm.bathrooms, createForm.sqft, createForm.service_type])

  // Fetch add-ons when create modal or add-charge form opens
  useEffect(() => {
    if (!createOpen && !addChargeOpen) return
    if (addonsList.length > 0) return // already fetched
    if (!isHouseCleaning) {
      // WinBros: use hard-coded pricebook add-ons
      setAddonsList(WINBROS_CALENDAR_ADDONS)
      // Fetch tenant-specific window tiers (falls back to hardcoded)
      fetch("/api/actions/settings")
        .then((r) => r.json())
        .then((res) => {
          if (res.window_tiers && Array.isArray(res.window_tiers) && res.window_tiers.length > 0) {
            setWindowTiers(res.window_tiers)
          }
        })
        .catch(() => {})
      return
    }
    fetch("/api/pricing/addons")
      .then((r) => r.json())
      .then((res) => {
        if (res.success && Array.isArray(res.data)) {
          setAddonsList(res.data)
        }
      })
      .catch(() => {})
  }, [createOpen, addChargeOpen])

  // Derive addon list with tier-specific prices for interior/track_detailing (WinBros)
  const derivedAddonsList = useMemo(() => {
    if (isHouseCleaning) return addonsList
    const raw = createForm.selected_tier_index
    const tierIdx = raw === "" ? -1 : Number(raw)
    const tier = tierIdx >= 0 && tierIdx < windowTiers.length ? windowTiers[tierIdx] : null
    return addonsList.map((addon) => {
      if (addon.addon_key === "interior" && tier) {
        return { ...addon, flat_price: tier.interior }
      }
      if (addon.addon_key === "track_detailing" && tier) {
        return { ...addon, flat_price: tier.trackDetailing }
      }
      return addon
    })
  }, [addonsList, createForm.selected_tier_index, windowTiers, isHouseCleaning])

  // Recalculate price and duration when add-ons, base price, or cleaner count change
  useEffect(() => {
    if (!basePrice && !createForm.selected_addons.length) return
    const st = (createForm.service_type || "").toLowerCase()
    const tierKey = st.includes("deep") ? "deep" : st.includes("move") ? "move" : "standard"
    const addonTotal = createForm.selected_addons.reduce((sum, key) => {
      const addon = derivedAddonsList.find((a) => a.addon_key === key)
      const dbInc = isHouseCleaning && Array.isArray((addon as any)?.included_in) && (addon as any).included_in.includes(tierKey)
      const codeInc = isHouseCleaning && (TIER_INCLUDED_ADDONS[tierKey] || []).includes(key)
      if (dbInc || codeInc) return sum
      return sum + (addon?.flat_price || 0)
    }, 0)
    const updates: Partial<CreateForm> = { price: String(basePrice + addonTotal) }
    // Auto-update duration if we have base labor minutes
    if (baseLaborMinutes > 0) {
      const addonMins = createForm.selected_addons.reduce((sum, key) => {
        const addon = derivedAddonsList.find((a) => a.addon_key === key)
        const dbInc = isHouseCleaning && Array.isArray((addon as any)?.included_in) && (addon as any).included_in.includes(tierKey)
        const codeInc = isHouseCleaning && (TIER_INCLUDED_ADDONS[tierKey] || []).includes(key)
        if (dbInc || codeInc) return sum
        return sum + (addon?.minutes || 0)
      }, 0)
      const count = Number(createForm.cleaner_count) || 1
      const wallMins = Math.ceil((baseLaborMinutes + addonMins) / count)
      updates.duration_minutes = String([60, 90, 120, 150, 180, 240, 300, 360, 420, 480].find(v => v >= wallMins) || 480)
    }
    setCreateForm((prev) => ({ ...prev, ...updates }))
  }, [createForm.selected_addons, createForm.cleaner_count, basePrice, baseLaborMinutes, derivedAddonsList])

  // Auto-populate price when window tier changes (WinBros only)
  useEffect(() => {
    if (isHouseCleaning) return
    if (createForm.selected_tier_index === "") return
    const tierIdx = Number(createForm.selected_tier_index)
    if (isNaN(tierIdx) || tierIdx < 0 || tierIdx >= windowTiers.length) return
    const tier = windowTiers[tierIdx]
    const base = tier.exterior
    setBasePrice(base)
    // Compute addon total directly from tier to avoid stale derivedAddonsList closure
    const addonTotal = createForm.selected_addons.reduce((sum, key) => {
      if (key === "interior") return sum + tier.interior
      if (key === "track_detailing") return sum + tier.trackDetailing
      const addon = addonsList.find((a) => a.addon_key === key)
      return sum + (addon?.flat_price || 0)
    }, 0)
    setCreateForm((prev) => ({ ...prev, price: String(base + addonTotal) }))
  }, [createForm.selected_tier_index, windowTiers])

  // Reset tier and price when WinBros service type changes away from window cleaning
  useEffect(() => {
    if (isHouseCleaning) return
    const isWindow = (createForm.service_type || "").toLowerCase().includes("window")
    if (!isWindow && createForm.selected_tier_index !== "") {
      setBasePrice(0)
    setBaseLaborMinutes(0)
      setCreateForm((prev) => ({ ...prev, selected_tier_index: "", price: "" }))
    }
  }, [createForm.service_type])

  // Addons included per tier (code-level source of truth, matches quote-pricing.ts)
  const TIER_INCLUDED_ADDONS: Record<string, string[]> = {
    deep: ['inside_fridge', 'inside_oven', 'inside_microwave', 'baseboards', 'ceiling_fans', 'light_fixtures', 'window_sills'],
    move: ['inside_fridge', 'inside_oven', 'inside_microwave', 'inside_cabinets', 'inside_dishwasher', 'range_hood', 'baseboards', 'ceiling_fans', 'light_fixtures', 'window_sills', 'wall_spot_cleaning', 'grout_scrubbing', 'behind_under_appliances', 'window_tracks', 'baseboards_hand_wipe', 'light_fixtures_detailed'],
  }

  // Auto-select add-ons included in the chosen service type (house cleaning only)
  useEffect(() => {
    if (!isHouseCleaning) return
    if (addonsList.length === 0) return
    const st = (createForm.service_type || "").toLowerCase()
    const tierKey = st.includes("deep") ? "deep" : st.includes("move") ? "move" : "standard"
    // Merge DB included_in with code-level fallback
    const dbIncludedKeys = addonsList
      .filter((a: any) => Array.isArray(a.included_in) && a.included_in.includes(tierKey))
      .map((a: any) => a.addon_key)
    const codeIncludedKeys = (TIER_INCLUDED_ADDONS[tierKey] || [])
      .filter((key) => addonsList.some((a: any) => a.addon_key === key))
    const includedKeys = [...new Set([...dbIncludedKeys, ...codeIncludedKeys])]
    // All addon keys that are included in ANY tier (so we can remove stale ones on switch)
    const allIncludableKeys = [
      ...addonsList
        .filter((a: any) => Array.isArray(a.included_in) && a.included_in.length > 0)
        .map((a: any) => a.addon_key),
      ...Object.values(TIER_INCLUDED_ADDONS).flat(),
    ]
    const allIncludableSet = [...new Set(allIncludableKeys)]
    setCreateForm((prev) => {
      // Keep manually-selected add-ons (ones not auto-includable), drop old auto-included, add new ones
      const manual = prev.selected_addons.filter((k) => !allIncludableSet.includes(k))
      const merged = [...new Set([...manual, ...includedKeys])]
      if (merged.length === prev.selected_addons.length && merged.every((k) => prev.selected_addons.includes(k))) return prev
      return { ...prev, selected_addons: merged }
    })
  }, [createForm.service_type, addonsList, isHouseCleaning])

  // Fetch service plans for membership dropdown + frequency discounts
  useEffect(() => {
    if (!createOpen || servicePlans.length > 0) return
    fetch("/api/service-plans")
      .then((r) => r.json())
      .then((res) => {
        if (res.plans) setServicePlans(res.plans)
      })
      .catch(() => {})
  }, [createOpen, isHouseCleaning])

  // Build preview form values from a customer (shared by preview and commit)
  const buildCustomerForm = (c: any, prev: CreateForm) => {
    const lastJob = c.last_job as { service_type?: string; addons?: { key: string }[]; price?: number } | null
    let lastServiceType = ""
    let lastAddons: string[] = []
    let lastTierIndex = ""
    if (lastJob) {
      lastServiceType = lastJob.service_type || ""
      if (Array.isArray(lastJob.addons)) {
        lastAddons = lastJob.addons.map((a) => a.key).filter(Boolean)
      }
      if (!isHouseCleaning && lastServiceType.toLowerCase().includes("window") && lastJob.price) {
        const bestMatch = windowTiers.reduce((best, t, idx) => {
          if (t.exterior <= lastJob.price! && t.exterior > (best.price || 0)) {
            return { idx, price: t.exterior }
          }
          return best
        }, { idx: -1, price: 0 })
        if (bestMatch.idx >= 0) lastTierIndex = String(bestMatch.idx)
      }
    }
    return {
      form: {
        ...prev,
        customer_name: [c.first_name, c.last_name].filter(Boolean).join(" ") || "",
        email: c.email || "",
        address: c.address || "",
        bedrooms: c.bedrooms ? String(c.bedrooms) : "",
        bathrooms: c.bathrooms ? String(c.bathrooms) : "",
        sqft: c.sqft ? String(c.sqft) : "",
        service_type: lastServiceType || prev.service_type || "",
        selected_addons: lastAddons.length > 0 ? lastAddons : [],
        selected_tier_index: lastTierIndex || "",
        price: lastJob?.price ? String(Number(lastJob.price)) : "",
        membership_id: "",
      },
      lastJob,
      lastServiceType,
      lastAddons,
      lastTierIndex,
    }
  }

  // Compute basePrice from last job (extracted to avoid calling setBasePrice inside setCreateForm updater)
  const computeLastJobBasePrice = (lastJob: any, lastServiceType: string, lastTierIndex: string, addons: string[]) => {
    if (!lastJob?.price || (lastServiceType.toLowerCase().includes("window") && lastTierIndex)) return null
    const st = lastServiceType.toLowerCase()
    const tierKey = st.includes("deep") ? "deep" : st.includes("move") ? "move" : "standard"
    const isHC = !st.includes("window")
    const addonTotal = addons.reduce((sum, key) => {
      const addon = derivedAddonsList.find((a) => a.addon_key === key)
      const dbInc = isHC && Array.isArray((addon as any)?.included_in) && (addon as any).included_in.includes(tierKey)
      const codeInc = isHC && (TIER_INCLUDED_ADDONS[tierKey] || []).includes(key)
      if (dbInc || codeInc) return sum
      return sum + (addon?.flat_price || 0)
    }, 0)
    return Number(lastJob.price) - addonTotal
  }

  // Preview customer on hover (reversible)
  const previewPhoneCustomer = (c: any) => {
    let newBase: number | null = null
    setCreateForm((prev) => {
      if (!formSnapshotRef.current) {
        formSnapshotRef.current = prev
        basePriceSnapshotRef.current = basePrice
      }
      const result = buildCustomerForm(c, formSnapshotRef.current)
      newBase = computeLastJobBasePrice(result.lastJob, result.lastServiceType, result.lastTierIndex, result.lastAddons)
      isPreviewingRef.current = true
      return result.form
    })
    setBasePrice(newBase !== null ? newBase : 0)
    setIsPreviewing(true)
  }

  // Revert preview on mouse leave (preserves current phone input)
  const revertPreview = () => {
    const snap = formSnapshotRef.current
    if (snap) {
      formSnapshotRef.current = null
      setCreateForm((prev) => ({
        ...snap,
        customer_phone: prev.customer_phone,
        selected_addons: snap.selected_addons || [],
      }))
      setBasePrice(basePriceSnapshotRef.current)
    }
    isPreviewingRef.current = false
    setIsPreviewing(false)
  }

  // Auto-fill form from a selected customer (commit)
  const selectPhoneCustomer = (c: any) => {
    const original = formSnapshotRef.current
    formSnapshotRef.current = null
    isPreviewingRef.current = false
    setIsPreviewing(false)
    setPhoneLookedUp(c.phone_number?.replace(/\D/g, "") || "")
    setLookedUpCustomerId(c.id || null)
    setShowPhoneSuggestions(false)

    let newBase: number | null = null
    setCreateForm((prev) => {
      const base = original || prev
      const result = buildCustomerForm(c, base)
      newBase = computeLastJobBasePrice(result.lastJob, result.lastServiceType, result.lastTierIndex, result.lastAddons)
      return { ...result.form, customer_phone: c.phone_number || result.form.customer_phone }
    })
    if (newBase !== null) setBasePrice(newBase)

    // Fetch active memberships for this customer (WinBros only)
    if (c.id && !isHouseCleaning) {
      fetch(`/api/actions/memberships?customer_id=${c.id}&status=active`)
        .then((r) => r.json())
        .then((mRes) => {
          const mems = mRes.data || []
          setCustomerMemberships(mems)
          if (mems.length === 1) {
            const mem = mems[0]
            setCreateForm((prev) => {
              if (prev.membership_id) return prev
              const updated = { ...prev, membership_id: `membership:${mem.id}` }
              const currentBase = basePrice || Number(prev.price) || 0
              if (mem.service_plans?.discount_per_visit && currentBase > 0) {
                updated.price = String(Math.max(0, currentBase - mem.service_plans.discount_per_visit))
              }
              return updated
            })
          }
        })
        .catch(() => setCustomerMemberships([]))
    }
  }

  // Keep a ref for lookedUpCustomerId to avoid stale closures in the fetch effect
  const lookedUpCustomerIdRef = useRef<string | null>(null)
  useEffect(() => { lookedUpCustomerIdRef.current = lookedUpCustomerId }, [lookedUpCustomerId])

  // Fetch phone suggestions (debounced, starts at 3 digits)
  useEffect(() => {
    if (!createOpen) return
    const digits = createForm.customer_phone.replace(/\D/g, "")
    if (digits.length < 3) {
      setPhoneSuggestions([])
      return
    }
    // Skip fetch if a customer was already committed (clicked)
    if (lookedUpCustomerIdRef.current) return

    // If previewing, revert first so the form reflects actual state
    if (isPreviewingRef.current) {
      revertPreview()
    }

    const controller = new AbortController()
    const timer = setTimeout(() => {
      if (lookedUpCustomerIdRef.current) return

      fetch(`/api/customers/lookup?phone=${encodeURIComponent(digits)}`, { signal: controller.signal })
        .then((r) => r.json())
        .then((res) => {
          if (lookedUpCustomerIdRef.current) return

          if (!res.success || !res.data?.length) {
            setPhoneSuggestions([])
            return
          }
          setPhoneSuggestions(res.data)
          setShowPhoneSuggestions(true)
        })
        .catch((err) => {
          if (err?.name !== "AbortError") setPhoneSuggestions([])
        })
    }, 400)

    return () => { clearTimeout(timer); controller.abort() }
  }, [createForm.customer_phone, createOpen])

  // Customer search (name/phone/email) — debounced
  useEffect(() => {
    if (!createOpen || customerSearch.length < 2) {
      setCustomerSearchResults([])
      return
    }
    if (lookedUpCustomerIdRef.current) return

    const controller = new AbortController()
    const timer = setTimeout(() => {
      fetch(`/api/customers/lookup?search=${encodeURIComponent(customerSearch)}`, { signal: controller.signal })
        .then((r) => r.json())
        .then((res) => {
          if (res.success && res.data?.length) {
            setCustomerSearchResults(res.data)
            setShowCustomerSearch(true)
          } else {
            setCustomerSearchResults([])
          }
        })
        .catch((err) => {
          if (err?.name !== "AbortError") setCustomerSearchResults([])
        })
    }, 350)

    return () => { clearTimeout(timer); controller.abort() }
  }, [customerSearch, createOpen])

  // Preview highlight helper — highlights all populated fields during hover preview
  const previewClass = (field: keyof CreateForm) =>
    isPreviewing && createForm[field] ? " previewing" : ""

  // Address suggestions via Google Places Autocomplete (debounced)
  useEffect(() => {
    if (!createOpen || !createForm.address || createForm.address.length < 3) {
      setAddressSuggestions([])
      return
    }

    const timer = setTimeout(() => {
      fetch(`/api/places/autocomplete?input=${encodeURIComponent(createForm.address)}`)
        .then((r) => r.json())
        .then((res) => {
          if (res.success && Array.isArray(res.data)) {
            setAddressSuggestions(res.data)
          }
        })
        .catch(() => {})
    }, 300)

    return () => clearTimeout(timer)
  }, [createForm.address, createOpen])

  // Drag-and-drop / edit state
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null)
  const [editMode, setEditMode] = useState(false)
  const [editForm, setEditForm] = useState({ date: "", time: "", cleanerIds: [] as string[], customerName: "", customerPhone: "", customerEmail: "", address: "", price: "", notes: "", serviceType: "", status: "" })
  const [cleanerDropdownOpen, setCleanerDropdownOpen] = useState(false)
  const cleanerDropdownRef = useRef<HTMLDivElement>(null)
  const [saving, setSaving] = useState(false)
  const [autoScheduling, setAutoScheduling] = useState(false)
  const [autoScheduleResult, setAutoScheduleResult] = useState<string | null>(null)
  const [cleanersList, setCleanersList] = useState<{ id: string; name: string }[]>([])
  const [sendToCleanerId, setSendToCleanerId] = useState("")
  const [sendToCleanerIds, setSendToCleanerIds] = useState<string[]>([])
  const [sendingToCleaner, setSendingToCleaner] = useState(false)
  const [sendToCleanerResult, setSendToCleanerResult] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteMode, setDeleteMode] = useState<"single" | "future" | null>(null)

  // Rainy day reschedule state
  const [rainOpen, setRainOpen] = useState(false)
  const [rainStep, setRainStep] = useState<"select" | "preview" | "loading" | "done">("select")
  const [rainDate, setRainDate] = useState("")
  const [rainPreview, setRainPreview] = useState<RainDayPreview | null>(null)
  const [rainResult, setRainResult] = useState<RainDayResult | null>(null)
  const [rainError, setRainError] = useState("")
  const [rainLoading, setRainLoading] = useState(false)

  // Close cleaner dropdown on outside click
  useEffect(() => {
    if (!cleanerDropdownOpen) return
    const handler = (e: MouseEvent) => {
      if (cleanerDropdownRef.current && !cleanerDropdownRef.current.contains(e.target as Node)) {
        setCleanerDropdownOpen(false)
      }
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [cleanerDropdownOpen])

  const timeFormat = useMemo(
    () =>
      ({
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      } as const),
    []
  )

  // Resolve logged-in user's cleaner_id for field view filtering
  useEffect(() => {
    if (isAdmin || !user?.id) return
    // Salesmen get their cleaner_id directly from auth context
    if (isSalesman && authCleanerId) {
      setMyCleanerId(authCleanerId)
      // Fetch crew info for the salesman so they can see full crew schedule
      fetch(`/api/actions/salesman-crew?cleaner_id=${authCleanerId}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => {
          if (d.crew_member_ids && Array.isArray(d.crew_member_ids)) {
            setCrewMemberIds(d.crew_member_ids)
          }
        })
        .catch(() => {})
      return
    }
    fetch("/api/actions/settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setMyCleanerId(d.cleaner_id ?? -1))
      .catch(() => setMyCleanerId(-1))
  }, [isAdmin, isSalesman, authCleanerId, user?.id])

  useEffect(() => {
    async function fetchJobs() {
      try {
        const [calRes, settingsRes] = await Promise.all([
          fetch("/api/calendar", { cache: "no-store" }),
          fetch("/api/actions/settings", { cache: "no-store" }),
        ])
        const calData = await calRes.json()
        setJobs(calData.jobs || [])

        const settingsData = await settingsRes.json()
        const types = settingsData.job_service_types as string[] | null
        if (types && Array.isArray(types) && types.length > 0) {
          setJobServiceTypes(types)
        }

        // Pre-load WinBros add-ons: merge quote add-ons + flat services into one list
        const customAddons = settingsData.winbros_addons as { addon_key: string; label: string; flat_price: number }[] | null
        const customFlat = settingsData.flat_services as { name: string; keywords: string[]; price: number }[] | null
        if (customAddons || customFlat) {
          const addonEntries = (customAddons || []).map((a) => ({
            addon_key: a.addon_key,
            label: a.label,
            flat_price: a.flat_price ?? 0,
            minutes: 0,
          }))
          const flatEntries = (customFlat || []).map((f) => ({
            addon_key: (f.keywords?.[0] || f.name.toLowerCase().replace(/\s+/g, "_")),
            label: f.name,
            flat_price: f.price ?? 0,
            minutes: 0,
          }))
          const merged = [...addonEntries, ...flatEntries]
          if (merged.length > 0) setAddonsList(merged)
        }
      } catch {
        setJobs([])
      } finally {
        setLoading(false)
      }
    }
    fetchJobs()
  }, [])

  // For field (non-admin) users, filter to only their jobs
  // Salesmen see all jobs on their crew's schedule
  const visibleJobs = useMemo(() => {
    if (isAdmin || !myCleanerId || myCleanerId <= 0) return jobs

    // Salesmen see all jobs assigned to any crew member
    if (isSalesman && crewMemberIds.length > 0) {
      return jobs.filter((job) => {
        // Show jobs assigned to any crew member
        if (job.cleaner_id && crewMemberIds.includes(job.cleaner_id)) return true
        // Also show jobs the salesman sold (regardless of crew assignment)
        if ((job as any).credited_salesman_id === myCleanerId) return true
        // Check cleaner assignments
        const assignedId = resolveCleanerId(job)
        if (assignedId && crewMemberIds.includes(Number(assignedId))) return true
        return false
      })
    }

    return jobs.filter((job) => {
      // Direct cleaner assignment
      if (job.cleaner_id === myCleanerId) return true
      // Check cleaner resolved from assignments
      const assignedId = resolveCleanerId(job)
      if (assignedId && Number(assignedId) === myCleanerId) return true
      // Check crew_day_members if present
      if (Array.isArray(job.cleaner_assignments)) {
        for (const a of job.cleaner_assignments) {
          const c = Array.isArray(a.cleaners) ? a.cleaners[0] : a.cleaners
          if (c?.id === myCleanerId) return true
        }
      }
      return false
    })
  }, [jobs, isAdmin, isSalesman, myCleanerId, crewMemberIds])

  const cleanerColorMap = useMemo(() => {
    const names = [...new Set(
      visibleJobs.map(j => resolveCleanerName(j)).filter(Boolean)
    )] as string[]
    const map = new Map<string, string>()
    names.sort().forEach((name, i) => {
      map.set(name, CLEANER_COLORS[i % CLEANER_COLORS.length])
    })
    return map
  }, [visibleJobs])

  const baseEvents = useMemo<EventInput[]>(() => {
    return visibleJobs.map((job) => {
      const start = resolveStart(job)
      const end = resolveEnd(job)
      const location = resolveLocation(job)
      const description = resolveServiceLabel(job)
      const cleanerName = resolveCleanerName(job)
      const cleanerId = resolveCleanerId(job)
      const teamName = resolveTeamName(job)
      const jobNotes = resolveNotes(job)
      const customerName = resolveCustomerName(job)
      const customer = resolveCustomer(job)
      const title = cleanerName
        ? `${customerName} (${cleanerName})`
        : job.title || job.service_type || customerName
      const className = eventClassForStatus(job.status)
      const cleanerColor = cleanerName ? cleanerColorMap.get(cleanerName) : undefined
      // Salesman visual distinction
      const isMySale = isSalesman && myCleanerId && job.credited_salesman_id === myCleanerId
      const isNotMySale = isSalesman && myCleanerId && job.credited_salesman_id !== myCleanerId
      const salesmanClasses = isMySale ? ['event-salesman-sold'] : isNotMySale ? ['event-salesman-not-sold'] : []

      return {
        id: String(job.id),
        title: isMySale ? `${title} [SOLD]` : isNotMySale ? `${title}` : title,
        start,
        end,
        classNames: [className, ...(job.membership_id ? ['event-membership'] : []), ...salesmanClasses],
        borderColor: cleanerColor,
        extendedProps: {
          description,
          location,
          resourceId: location,
          client: customerName,
          cleaner: cleanerName || "",
          cleanerName: cleanerName || "",
          cleanerId: cleanerId || "",
          teamName: teamName || "",
          service: description || "",
          notes: jobNotes || "",
          price: job.price || job.estimated_value || 0,
          status: job.status || "scheduled",
          jobId: String(job.id),
          hours: job.hours ? Number(job.hours) : 2,
          cardOnFile: !!customer?.card_on_file_at,
          frequency: job.frequency || "one-time",
          parentJobId: job.parent_job_id ? String(job.parent_job_id) : null,
          jobType: (job as any).job_type || "",
          isCommercial: !!customer?.is_commercial,
          leadSource: resolveLeadSource(job),
          customerPhone: customer?.phone_number || job.phone_number || "",
          customerEmail: customer?.email || "",
          salesmanName: resolveSalesmanName(job),
          customerId: customer?.id ? String(customer.id) : "",
        },
      }
    })
  }, [visibleJobs, cleanerColorMap])

  const ganttJobs = useMemo<GanttJob[]>(() => {
    return visibleJobs.map((job) => ({
      id: String(job.id),
      customerName: resolveCustomerName(job),
      cleanerName: resolveCleanerName(job) || "",
      cleanerId: resolveCleanerId(job),
      start: resolveStart(job),
      end: resolveEnd(job),
      status: job.status || "scheduled",
      color: cleanerColorMap.get(resolveCleanerName(job) || ""),
    }))
  }, [visibleJobs, cleanerColorMap])

  const handleGanttJobClick = useCallback((jobId: string) => {
    const job = visibleJobs.find((j) => String(j.id) === jobId)
    if (!job) return
    const start = resolveStart(job)
    const end = resolveEnd(job)
    const cleanerName = resolveCleanerName(job)
    const cleanerId = resolveCleanerId(job)
    const customerName = resolveCustomerName(job)
    const customer = resolveCustomer(job)
    const details: CalendarEventDetails = {
      jobId: String(job.id),
      title: cleanerName ? `${customerName} (${cleanerName})` : customerName,
      start,
      end,
      location: resolveLocation(job) || "",
      description: resolveServiceLabel(job) || "",
      status: job.status || "scheduled",
      price: job.price || job.estimated_value || 0,
      client: customerName,
      cleaner: cleanerName || "",
      cleanerName: cleanerName || "",
      cleanerId: cleanerId || "",
      team: resolveTeamName(job) || "",
      service: resolveServiceLabel(job) || "",
      notes: resolveNotes(job) || "",
      hours: job.hours ? Number(job.hours) : 2,
      cardOnFile: !!customer?.card_on_file_at,
      frequency: job.frequency || "one-time",
      parentJobId: job.parent_job_id ? String(job.parent_job_id) : null,
      jobType: (job as any).job_type || "",
      leadSource: resolveLeadSource(job),
      customerPhone: customer?.phone_number || job.phone_number || "",
      customerEmail: customer?.email || "",
      customerId: customer?.id ? String(customer.id) : "",
      salesmanName: resolveSalesmanName(job),
    }
    setSelectedEvent(details)
    setEditMode(false)
    setConfirmDelete(false)
    setAutoScheduleResult(null)
    setAddChargeOpen(false)
    setSendToCleanerId("")
    setSendToCleanerResult(null)
  }, [visibleJobs])

  // Open job details after creation once jobs list refreshes
  useEffect(() => {
    if (pendingJobOpenRef.current) {
      const jobId = pendingJobOpenRef.current
      const job = visibleJobs.find((j) => String(j.id) === jobId)
      if (job) {
        pendingJobOpenRef.current = null
        handleGanttJobClick(jobId)
      }
    }
  }, [visibleJobs, handleGanttJobClick])

  const handleSelect = (info: DateSelectArg) => {
    // Selecting a calendar slot opens the new QuoteBuilder Sheet popup, not
    // the legacy create-job form. Same UX as clicking "+ New Quote" up top.
    // Date/time of the selection is informational only — the quote builder
    // owns scheduling once it converts.
    info.view.calendar.unselect()
    void startNewQuote()
  }

  const handleEventClick = (info: EventClickArg) => {
    const start = info.event.start
    const end = info.event.end
    const details: CalendarEventDetails = {
      jobId: info.event.id || info.event.extendedProps.jobId || "",
      title: info.event.title || "(no title)",
      start,
      end,
      location: info.event.extendedProps.location || emptyValue,
      description: info.event.extendedProps.description || emptyValue,
      status: info.event.extendedProps.status || "scheduled",
      price: info.event.extendedProps.price || 0,
      client: info.event.extendedProps.client || emptyValue,
      cleaner: info.event.extendedProps.cleaner || "",
      cleanerName: info.event.extendedProps.cleanerName || "",
      cleanerId: info.event.extendedProps.cleanerId || "",
      team: info.event.extendedProps.teamName || "",
      service: info.event.extendedProps.service || "",
      notes: info.event.extendedProps.notes || "",
      hours: info.event.extendedProps.hours || 2,
      cardOnFile: !!info.event.extendedProps.cardOnFile,
      frequency: info.event.extendedProps.frequency || "one-time",
      parentJobId: info.event.extendedProps.parentJobId || null,
      jobType: info.event.extendedProps.jobType || "",
      leadSource: info.event.extendedProps.leadSource || "",
      customerPhone: info.event.extendedProps.customerPhone || "",
      customerEmail: info.event.extendedProps.customerEmail || "",
      customerId: info.event.extendedProps.customerId || "",
      salesmanName: info.event.extendedProps.salesmanName || "",
    }
    // Field roles get the rich JobDetailDrawer immediately on click — same
    // full-detail UX the mobile portal had (checklist, price book, service
    // plan, tech upsells, payment). Admins still go through the bare modal
    // first because it has admin-only quick actions (auto-schedule, send to
    // cleaner) the drawer doesn't surface.
    if (isFieldRole && details.jobId) {
      setDrawerJobId(details.jobId)
      return
    }
    setSelectedEvent(details)
    setEditMode(false)
    setConfirmDelete(false)
    setAutoScheduleResult(null)
    setAddChargeOpen(false)
    setSendToCleanerId("")
    setSendToCleanerResult(null)
    pmReset()

    // Load cleaners list for send-to-cleaner dropdown (view mode)
    if (cleanersList.length === 0) {
      fetch("/api/teams").then(r => r.json()).then(data => {
        const all: { id: string; name: string }[] = []
        for (const team of data.data || []) {
          for (const member of team.members || []) {
            all.push({ id: String(member.id), name: member.name })
          }
        }
        for (const c of data.unassigned_cleaners || []) {
          all.push({ id: String(c.id), name: c.name })
        }
        setCleanersList(all)
      }).catch(() => {})
    }
  }

  const refreshJobs = async () => {
    try {
      const res = await fetch("/api/calendar", { cache: "no-store" })
      const data = await res.json()
      setJobs(data.jobs || [])
    } catch { /* ignore */ }
  }

  const saveJobTime = async (jobId: string, newStart: Date, hours: number): Promise<boolean> => {
    const date = `${newStart.getFullYear()}-${String(newStart.getMonth() + 1).padStart(2, "0")}-${String(newStart.getDate()).padStart(2, "0")}`
    const scheduled_at = `${String(newStart.getHours()).padStart(2, "0")}:${String(newStart.getMinutes()).padStart(2, "0")}`
    try {
      const res = await fetch("/api/jobs", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: jobId, date, scheduled_at }),
      })
      const data = await res.json()
      return data.success === true
    } catch {
      return false
    }
  }

  const findConflicts = (cleanerName: string, newStart: Date, newEnd: Date, excludeEventId: string) => {
    if (!cleanerName) return []
    return baseEvents.filter((e) => {
      if (String(e.id) === excludeEventId) return false
      if ((e.extendedProps as any)?.cleanerName !== cleanerName) return false
      const eStart = new Date(e.start as any)
      const eEnd = new Date(e.end as any)
      return newStart < eEnd && eStart < newEnd
    })
  }

  const handleEventDrop = async (info: EventDropArg) => {
    const { event, revert } = info
    const newStart = event.start!
    const hours = event.extendedProps.hours || 2
    const newEnd = event.end || new Date(newStart.getTime() + hours * 3600000)
    const cleanerName = event.extendedProps.cleanerName || ""
    const jobId = event.id

    if (!cleanerName) {
      setSaving(true)
      const saved = await saveJobTime(jobId, newStart, hours)
      if (!saved) revert()
      else await refreshJobs()
      setSaving(false)
      return
    }

    const conflicts = findConflicts(cleanerName, newStart, newEnd, jobId)
    if (conflicts.length === 0) {
      setSaving(true)
      const saved = await saveJobTime(jobId, newStart, hours)
      if (!saved) revert()
      else await refreshJobs()
      setSaving(false)
      return
    }

    const conflict = conflicts[0]
    setPendingMove({
      jobId,
      newStart,
      newEnd,
      hours,
      cleanerName,
      conflictJobId: String(conflict.id),
      conflictTitle: conflict.title as string,
      conflictStart: new Date(conflict.start as any),
      conflictEnd: new Date(conflict.end as any),
      conflictHours: (conflict.extendedProps as any)?.hours || 2,
      revert,
      source: "drag",
    })
  }

  const handleConfirmMove = async () => {
    if (!pendingMove) return
    setSaving(true)

    const saved = await saveJobTime(pendingMove.jobId, pendingMove.newStart, pendingMove.hours)
    if (!saved) {
      pendingMove.revert?.()
      setPendingMove(null)
      setSaving(false)
      return
    }

    const newConflictStart = pendingMove.newEnd
    await saveJobTime(pendingMove.conflictJobId, newConflictStart, pendingMove.conflictHours)

    if (pendingMove.source === "edit") {
      setSelectedEvent(null)
      setEditMode(false)
    }

    setPendingMove(null)
    setSaving(false)
    await refreshJobs()
  }

  const handleCancelMove = () => {
    pendingMove?.revert?.()
    setPendingMove(null)
  }

  const handleStartEdit = async () => {
    if (!selectedEvent?.start) return
    const d = selectedEvent.start
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`

    // Resolve all assigned cleaner IDs from cleaner_assignments (not just the primary FK)
    const job = visibleJobs.find(j => String(j.id) === selectedEvent.jobId)
    const assignments = job?.cleaner_assignments
    let initialCleanerIds: string[] = []
    if (Array.isArray(assignments) && assignments.length > 0) {
      initialCleanerIds = assignments
        .filter((a: any) => a.status === "confirmed" || a.status === "accepted" || a.status === "pending")
        .map((a: any) => {
          const c = Array.isArray(a.cleaners) ? a.cleaners[0] : a.cleaners
          return c?.id ? String(c.id) : String(a.cleaner_id)
        })
        .filter(Boolean)
    }
    // Fallback to primary cleaner if no assignments found
    if (initialCleanerIds.length === 0 && selectedEvent.cleanerId) {
      initialCleanerIds = [selectedEvent.cleanerId]
    }

    setEditForm({
      date, time,
      cleanerIds: initialCleanerIds,
      customerName: selectedEvent.client || "",
      customerPhone: selectedEvent.customerPhone || "",
      customerEmail: selectedEvent.customerEmail || "",
      address: selectedEvent.location || "",
      price: selectedEvent.price ? String(selectedEvent.price) : "",
      notes: selectedEvent.notes || "",
      serviceType: selectedEvent.service || "",
      status: selectedEvent.status || "",
    })
    setCleanerDropdownOpen(false)
    setEditMode(true)

    // Fetch cleaners list if not already loaded
    if (cleanersList.length === 0) {
      try {
        const res = await fetch("/api/teams")
        const data = await res.json()
        const all: { id: string; name: string }[] = []
        for (const team of data.data || []) {
          for (const member of team.members || []) {
            all.push({ id: String(member.id), name: member.name })
          }
        }
        for (const c of data.unassigned_cleaners || []) {
          all.push({ id: String(c.id), name: c.name })
        }
        setCleanersList(all)
      } catch { /* ignore, dropdown will just be empty */ }
    }
  }

  const handleAutoSchedule = async () => {
    if (!selectedEvent) return
    setAutoScheduling(true)
    setAutoScheduleResult(null)
    try {
      const res = await fetch('/api/actions/auto-schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: selectedEvent.jobId }),
      })
      const data = await res.json()
      if (res.ok && data.success) {
        setAutoScheduleResult(`Scheduled: ${data.display}${data.team_name ? ` (${data.team_name})` : ''}`)
        await refreshJobs()
      } else {
        setAutoScheduleResult(`Error: ${data.error || 'Failed to auto-schedule'}`)
      }
    } catch {
      setAutoScheduleResult('Error: Network request failed')
    } finally {
      setAutoScheduling(false)
    }
  }

  const handleSendToCleaner = async () => {
    if (!selectedEvent || sendToCleanerIds.length === 0) return
    setSendingToCleaner(true)
    setSendToCleanerResult(null)
    try {
      const res = await fetch('/api/actions/notify-cleaners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: selectedEvent.jobId, cleanerIds: sendToCleanerIds }),
      })
      const data = await res.json()
      if (res.ok && data.success) {
        setSendToCleanerResult(`Sent to ${data.notified} cleaner${data.notified === 1 ? '' : 's'} — waiting for response`)
        setSendToCleanerIds([])
        await refreshJobs()
      } else {
        setSendToCleanerResult(`Error: ${data.error || 'Failed to send'}`)
      }
    } catch {
      setSendToCleanerResult('Error: Network request failed')
    } finally {
      setSendingToCleaner(false)
    }
  }

  const [sendingRanked, setSendingRanked] = useState(false)
  const [sendRankedResult, setSendRankedResult] = useState<string | null>(null)
  const handleSendRanked = async () => {
    if (!selectedEvent) return
    setSendingRanked(true)
    setSendRankedResult(null)
    try {
      const res = await fetch('/api/actions/assign-cleaner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: selectedEvent.jobId, mode: 'ranked' }),
      })
      const data = await res.json()
      if (res.ok && data.success) {
        setSendRankedResult('Sent to #1 ranked cleaner — will cascade if no response in 20 min')
        await refreshJobs()
      } else {
        setSendRankedResult(`Error: ${data.error || 'Failed'}`)
      }
    } catch {
      setSendRankedResult('Error: Network request failed')
    } finally {
      setSendingRanked(false)
    }
  }

  const handleAddCharge = async () => {
    if (!selectedEvent || !addChargeType) return
    setAddChargeSaving(true)
    try {
      const body: Record<string, unknown> = { job_id: selectedEvent.jobId, addon_type: addChargeType }
      if (addChargeType === "custom" && addChargeAmount) {
        body.amount = parseFloat(addChargeAmount)
        body.description = addChargeDesc || "Custom charge"
        body.addon_type = addChargeDesc || "custom_charge"
      } else {
        // Send amount + description from local add-ons list as fallback
        // (covers hard-coded WinBros add-ons not in the DB pricing_addons table)
        const preset = addonsList.find((a) => a.addon_key === addChargeType)
        if (preset?.flat_price) {
          body.amount = preset.flat_price
          body.description = preset.label
        }
      }
      const res = await fetch("/api/actions/add-charge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (data.success) {
        // Update the selected event price in UI
        setSelectedEvent(prev => prev ? { ...prev, price: data.new_total } : prev)
        setAddChargeOpen(false)
        setAddChargeType("")
        setAddChargeAmount("")
        setAddChargeDesc("")
      } else {
        alert(data.error || "Failed to add charge")
      }
    } catch {
      alert("Failed to add charge")
    } finally {
      setAddChargeSaving(false)
    }
  }

  // ── Payment menu helpers (used in quote success + event detail) ──
  const pmReset = () => {
    setPmOpen(false); setPmType(null); setPmResult(null); setPmAmount(""); setPmJobId("")
    setPmChargeResult(null); setPmChargeDesc(""); setPmCopied(false); setPmSmsSent(false); setPmError(null); setPmPos(null)
  }

  const pmToggle = (jobId?: string) => {
    if (pmOpen) { pmReset(); return }
    // Calculate position from button
    const rect = pmBtnRef.current?.getBoundingClientRect()
    if (rect) {
      const menuWidth = 288 // w-72
      const menuHeight = 300 // approx
      let top = rect.bottom + 4
      let left = rect.right - menuWidth
      // If overflows bottom, open upward
      if (top + menuHeight > window.innerHeight) top = rect.top - menuHeight - 4
      // Keep on screen
      if (left < 8) left = 8
      if (top < 8) top = 8
      setPmPos({ top, left })
    } else {
      // Fallback: center
      setPmPos({ top: window.innerHeight / 4, left: Math.max(8, (window.innerWidth - 288) / 2) })
    }
    setPmType(null); setPmResult(null); setPmAmount(""); setPmChargeResult(null); setPmChargeDesc(""); setPmError(null)
    if (jobId) setPmJobId(jobId)
    setPmOpen(true)
  }

  const pmGetCustomerId = (): string | null => {
    if (quoteSuccess?.customerId) return quoteSuccess.customerId
    if (selectedEvent?.customerId) return selectedEvent.customerId
    return lookedUpCustomerId
  }

  const pmGetCustomerPhone = (): string | null => {
    if (quoteSuccess?.customerPhone) return quoteSuccess.customerPhone
    if (selectedEvent?.customerPhone) return selectedEvent.customerPhone
    return null
  }

  const pmGenerateLink = async (type: string): Promise<boolean> => {
    const customerId = pmGetCustomerId()
    if (!customerId) { setPmError("No customer found"); return false }
    setPmLoading(true)
    setPmResult(null)
    setPmError(null)
    setPmCopied(false)
    setPmSmsSent(false)
    try {
      const body: Record<string, unknown> = { customerId, type }
      if (type === "payment") {
        body.amount = parseFloat(pmAmount)
        body.description = "Payment"
      }
      if (pmJobId) body.jobId = pmJobId
      const res = await fetch("/api/actions/generate-payment-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (res.ok && json.success) {
        setPmResult({ url: json.url, invoiceId: json.invoiceId })
        return true
      } else {
        setPmError(json.error || "Failed to generate link")
        return false
      }
    } catch {
      setPmError("Failed to generate link")
      return false
    } finally {
      setPmLoading(false)
    }
  }

  const pmCopy = () => {
    if (pmResult?.url) {
      navigator.clipboard.writeText(pmResult.url)
      setPmCopied(true)
      setTimeout(() => setPmCopied(false), 2000)
    }
  }

  const pmSendSms = async () => {
    const phone = pmGetCustomerPhone()
    if (!pmResult?.url || !phone || pmSmsSending || pmSmsSent) return
    setPmSmsSending(true)
    try {
      const res = await fetch("/api/actions/send-sms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: phone, message: `Here's your payment link: ${pmResult.url}` }),
      })
      const json = await res.json()
      if (json.success) {
        setPmSmsSent(true)
      } else {
        setPmError(json.error || "Failed to send SMS")
      }
    } catch {
      setPmError("Failed to send SMS")
    } finally {
      setPmSmsSending(false)
    }
  }

  const pmChargeCard = async () => {
    const customerId = pmGetCustomerId()
    if (!customerId || pmChargeLoading) return
    const amt = parseFloat(pmAmount)
    if (!amt || amt <= 0) return
    setPmChargeLoading(true)
    setPmChargeResult(null)
    try {
      const res = await fetch("/api/actions/charge-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer_id: customerId, amount: amt, description: pmChargeDesc || undefined }),
      })
      const json = await res.json()
      if (res.ok && json.success) {
        setPmChargeResult({ success: true, amount: json.amount })
      } else {
        setPmChargeResult({ success: false, error: json.error || "Charge failed" })
      }
    } catch {
      setPmChargeResult({ success: false, error: "Failed to charge card" })
    } finally {
      setPmChargeLoading(false)
    }
  }

  // Close payment popover on outside click
  useEffect(() => {
    if (!pmOpen) return
    const handler = (e: MouseEvent) => {
      const t = e.target as Node
      if (pmRef.current?.contains(t)) return
      if (pmBtnRef.current?.contains(t)) return
      pmReset()
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [pmOpen])

  const handleDeleteJob = async (mode: "single" | "future") => {
    if (!selectedEvent) return
    setDeleteMode(mode)
    setSaving(true)
    try {
      if (mode === "future") {
        // Server-side handles finding all related jobs (children + orphaned siblings by customer_id)
        const res = await fetch("/api/actions/recurring", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "delete-future", job_id: Number(selectedEvent.jobId) }),
        })
        const data = await res.json()
        if (!res.ok) {
          alert(data.error || "Failed to delete recurring jobs")
          return
        }
      } else {
        const res = await fetch(`/api/jobs?id=${selectedEvent.jobId}`, { method: "DELETE" })
        const data = await res.json()
        if (!data.success) {
          alert(data.error || "Failed to delete job")
          return
        }
      }

      setSelectedEvent(null)
      setEditMode(false)
      setConfirmDelete(false)
      setDeleteMode(null)
      await refreshJobs()
    } finally {
      setSaving(false)
    }
  }

  const handleEditSave = async () => {
    if (!selectedEvent || !editForm.date || !editForm.time) return
    const newStart = new Date(`${editForm.date}T${editForm.time}:00`)
    if (isNaN(newStart.getTime())) return

    const hours = selectedEvent.hours || 2
    const newEnd = new Date(newStart.getTime() + hours * 3600000)
    const jobId = selectedEvent.jobId

    // Use the NEW cleaners from the edit form for conflict detection (check first/primary cleaner)
    const primaryCleanerId = editForm.cleanerIds[0] || ""
    const newCleanerName = primaryCleanerId
      ? cleanersList.find((c) => c.id === primaryCleanerId)?.name || ""
      : ""

    if (newCleanerName) {
      const conflicts = findConflicts(newCleanerName, newStart, newEnd, jobId)
      if (conflicts.length > 0) {
        const conflict = conflicts[0]
        setPendingMove({
          jobId,
          newStart,
          newEnd,
          hours,
          cleanerName: newCleanerName,
          conflictJobId: String(conflict.id),
          conflictTitle: conflict.title as string,
          conflictStart: new Date(conflict.start as any),
          conflictEnd: new Date(conflict.end as any),
          conflictHours: (conflict.extendedProps as any)?.hours || 2,
          revert: null,
          source: "edit",
        })
        return
      }
    }

    setSaving(true)
    const date = editForm.date
    const scheduled_at = editForm.time
    const body: Record<string, any> = { id: jobId, date, scheduled_at }

    // Send cleaner_ids array; API will set primary cleaner_id and create assignments for all
    body.cleaner_ids = editForm.cleanerIds.length > 0 ? editForm.cleanerIds : null
    body.cleaner_id = primaryCleanerId || null

    // Customer + job fields
    if (editForm.customerName !== (selectedEvent.client || "")) body.customer_name = editForm.customerName
    if (editForm.customerPhone !== (selectedEvent.customerPhone || "")) body.customer_phone = editForm.customerPhone
    if (editForm.customerEmail !== (selectedEvent.customerEmail || "")) body.customer_email = editForm.customerEmail
    if (editForm.address !== (selectedEvent.location || "")) { body.customer_address = editForm.address; body.address = editForm.address }
    if (editForm.price !== (selectedEvent.price ? String(selectedEvent.price) : "")) body.price = editForm.price ? Number(editForm.price) : null
    if (editForm.notes !== (selectedEvent.notes || "")) body.notes = editForm.notes
    if (editForm.serviceType !== (selectedEvent.service || "")) body.service_type = editForm.serviceType
    if (editForm.status !== (selectedEvent.status || "")) body.status = editForm.status

    try {
      const res = await fetch("/api/jobs", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (data.success) {
        const jobId = selectedEvent.jobId
        setSelectedEvent(null)
        setEditMode(false)
        pendingJobOpenRef.current = jobId
        await refreshJobs()
      } else {
        console.error("[edit-save] Failed:", data.error)
        alert(`Save failed: ${data.error || "Unknown error"}`)
      }
    } catch (err) {
      console.error("[edit-save] Network error:", err)
      alert("Save failed — network error")
    } finally {
      setSaving(false)
    }
  }

  const openRainDay = () => {
    setRainOpen(true)
    setRainStep("select")
    setRainDate("")
    setRainPreview(null)
    setRainResult(null)
    setRainError("")
  }

  const handleRainPreview = async () => {
    if (!rainDate) return
    setRainLoading(true)
    setRainError("")
    try {
      const res = await fetch(`/api/rain-day?date=${rainDate}`)
      const data = await res.json()
      if (!data.success) {
        setRainError(data.error || "Failed to fetch preview")
        return
      }
      setRainPreview(data.data)
      setRainStep("preview")
    } catch {
      setRainError("Failed to connect to server")
    } finally {
      setRainLoading(false)
    }
  }

  const handleRainConfirm = async () => {
    if (!rainDate) return
    setRainStep("loading")
    setRainError("")
    try {
      const res = await fetch("/api/rain-day", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ affected_date: rainDate, auto_spread: true }),
      })
      const data = await res.json()
      if (!data.success) {
        setRainError(data.error || "Reschedule failed")
        setRainStep("preview")
        return
      }
      setRainResult(data.data)
      setRainStep("done")
      // Refresh calendar
      const calRes = await fetch("/api/calendar")
      const calData = await calRes.json()
      setJobs(calData.jobs || [])
    } catch {
      setRainError("Failed to connect to server")
      setRainStep("preview")
    }
  }

  const formatSpreadDate = (dateStr: string) => {
    return new Date(dateStr + "T12:00:00").toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    })
  }

  const handleCreateSave = async () => {
    const phone = createForm.customer_phone.trim()
    if (!phone) {
      setCreateError("Customer phone number is required")
      return
    }
    if (!createForm.date) {
      setCreateError("Date is required")
      return
    }
    if (isHouseCleaning) {
      if (!createForm.bedrooms) {
        setCreateError("Number of bedrooms is required")
        return
      }
      if (!createForm.bathrooms) {
        setCreateError("Number of bathrooms is required")
        return
      }
    }
    if (!isHouseCleaning && (createForm.service_type || "").toLowerCase().includes("window") && !createForm.selected_tier_index) {
      setCreateError("Please select a window cleaning tier")
      return
    }
    if (!createForm.lead_source.trim() || createForm.lead_source === "__custom__") {
      setCreateError("Lead source is required")
      return
    }

    setCreateSaving(true)
    setCreateError("")
    setQuoteSuccess(null)

    try {
      // ── Quote flow: create a real quote with tier selection page ──
      if (createForm.is_quote) {
        const res = await fetch("/api/actions/quotes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customer_id: lookedUpCustomerId ? Number(lookedUpCustomerId) : undefined,
            customer_name: createForm.customer_name.trim() || "Customer",
            customer_phone: phone,
            customer_email: createForm.email.trim() || undefined,
            customer_address: createForm.address.trim() || undefined,
            square_footage: createForm.sqft ? Number(createForm.sqft) : undefined,
            bedrooms: createForm.bedrooms ? Number(createForm.bedrooms) : undefined,
            bathrooms: createForm.bathrooms ? Number(createForm.bathrooms) : undefined,
            service_category: (createForm.service_type || "").toLowerCase().includes("move") ? "move_in_out" : "standard",
            selected_tier: (() => {
              const st = (createForm.service_type || "").toLowerCase()
              if (st.includes("move")) return "move"
              if (st.includes("deep")) return "deep"
              // extra_deep removed — add-ons cover premium items
              return "standard"
            })(),
            notes: createForm.notes.trim() || undefined,
            custom_base_price: createForm.price ? Number(createForm.price) : undefined,
            membership_plan: (() => {
              if (!isHouseCleaning || !createForm.frequency || createForm.frequency === "one-time") return undefined
              const map: Record<string, string> = { "weekly": "weekly", "bi-weekly": "biweekly", "monthly": "monthly" }
              return map[createForm.frequency]
            })(),
            send_sms: false,
          }),
        })

        const data = await res.json()
        if (!data.success) {
          setCreateError(data.error || "Failed to create quote")
          return
        }

        setQuoteSuccess({
          url: data.quote_url || `/quote/${data.quote?.token}`,
          token: data.quote?.token,
          quoteId: data.quote?.id != null ? String(data.quote.id) : undefined,
          sent: false,
          customerPhone: phone,
          customerId: lookedUpCustomerId ? String(lookedUpCustomerId) : data.quote?.customer_id ? String(data.quote.customer_id) : undefined,
        })
        return
      }

      // ── Normal job flow ──
      // Resolve membership: existing membership ID or create new one from plan slug
      let resolvedMembershipId: string | undefined
      const memVal = createForm.membership_id
      if (memVal.startsWith("membership:")) {
        resolvedMembershipId = memVal.replace("membership:", "")
      } else if (memVal.startsWith("plan:") && !lookedUpCustomerId) {
        setCreateError("Customer must be found before creating a membership")
        setCreateSaving(false)
        return
      } else if (memVal.startsWith("plan:")) {
        const planSlug = memVal.replace("plan:", "")
        const memRes = await fetch("/api/actions/memberships", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ customer_id: lookedUpCustomerId, plan_slug: planSlug }),
        })
        const memData = await memRes.json()
        if (!memData.success) {
          setCreateError(memData.error || "Failed to create membership")
          setCreateSaving(false)
          return
        }
        resolvedMembershipId = memData.membership?.id
      }

      // Compute frequency discount for house cleaning
      let frequencyDiscount = 0
      let frequencyPlanSlug: string | undefined
      if (isHouseCleaning && createForm.frequency && createForm.frequency !== "one-time") {
        const freqSlugMap: Record<string, string> = { "weekly": "weekly", "bi-weekly": "biweekly", "monthly": "monthly" }
        const slug = freqSlugMap[createForm.frequency]
        if (slug) {
          const plan = servicePlans.find((p) => p.slug === slug)
          if (plan) { frequencyDiscount = plan.discount_per_visit || 0; frequencyPlanSlug = plan.slug }
        }
      }

      // If no override price, compute from base + addons - discount
      let finalPrice = createForm.price ? Number(createForm.price) : undefined
      if (!createForm.price && basePrice > 0) {
        const addonTotal = createForm.selected_addons.reduce((sum, key) => {
          const addon = derivedAddonsList.find((a) => a.addon_key === key)
          const st = (createForm.service_type || "").toLowerCase()
          const tierKey = st.includes("deep") ? "deep" : st.includes("move") ? "move" : "standard"
          const TIER_INCLUDED: Record<string, string[]> = {
            deep: ['inside_fridge', 'inside_oven', 'inside_microwave', 'baseboards', 'ceiling_fans', 'light_fixtures', 'window_sills'],
            move: ['inside_fridge', 'inside_oven', 'inside_microwave', 'inside_cabinets', 'inside_dishwasher', 'range_hood', 'baseboards', 'ceiling_fans', 'light_fixtures', 'window_sills'],
          }
          const included = (TIER_INCLUDED[tierKey] || []).includes(key) || (Array.isArray((addon as any)?.included_in) && (addon as any).included_in.includes(tierKey))
          if (included) return sum
          return sum + (addon?.flat_price || 0)
        }, 0)
        finalPrice = Math.max(0, basePrice + addonTotal - frequencyDiscount)
      }

      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customer_phone: phone,
          customer_name: createForm.customer_name.trim() || undefined,
          email: createForm.email.trim() || undefined,
          address: createForm.address.trim() || undefined,
          service_type: createForm.service_type || (isHouseCleaning ? "Standard cleaning" : "Window cleaning"),
          scheduled_date: createForm.date,
          scheduled_time: createForm.time || "09:00",
          duration_minutes: Number(createForm.duration_minutes) || 120,
          estimated_value: finalPrice,
          notes: createForm.notes.trim() || undefined,
          bedrooms: createForm.bedrooms ? Number(createForm.bedrooms) : undefined,
          bathrooms: createForm.bathrooms ? Number(createForm.bathrooms) : undefined,
          sqft: createForm.sqft ? Number(createForm.sqft) : undefined,
          frequency: createForm.frequency !== "one-time" ? createForm.frequency : undefined,
          membership_id: resolvedMembershipId,
          cleaner_ids: createForm.assignment_mode === "specific" && createForm.cleaner_ids.length > 0 ? createForm.cleaner_ids : undefined,
          assignment_mode: createForm.assignment_mode,
          cleaner_count: Number(createForm.cleaner_count) || 1,
          status: "scheduled",
          lead_source: createForm.lead_source.trim() && createForm.lead_source !== "__custom__" ? createForm.lead_source.trim() : undefined,
          credited_salesman_id: createForm.credited_salesman_id ? Number(createForm.credited_salesman_id) : undefined,
          addons: createForm.selected_addons.length > 0 ? createForm.selected_addons.map((key) => {
            const addon = derivedAddonsList.find((a) => a.addon_key === key)
            return { key, label: addon?.label || key, price: addon?.flat_price || 0 }
          }) : undefined,
        }),
      })

      const data = await res.json()
      if (!data.success) {
        setCreateError(data.error || "Failed to create job")
        return
      }

      setCreateOpen(false)
      setPhoneLookedUp("")
      setPhoneSuggestions([])
      setShowPhoneSuggestions(false)
      setCustomerSearch("")
      setCustomerSearchResults([])
      formSnapshotRef.current = null
      isPreviewingRef.current = false
      basePriceSnapshotRef.current = 0
      setIsPreviewing(false)
      setLookedUpCustomerId(null)
      setCustomerMemberships([])
      // Open the new job's detail view after refresh
      const newJobId = data.data?.id
      if (newJobId) pendingJobOpenRef.current = String(newJobId)
      await refreshJobs()
    } catch {
      setCreateError("Connection error. Please try again.")
    } finally {
      setCreateSaving(false)
    }
  }

  // ── Reusable payment menu popover ──
  const renderPaymentMenu = (showCardOnFile: boolean) => {
    if (!pmPos) return null
    const content = (
    <>
      <div className="fixed inset-0 bg-black/20" style={{ zIndex: 9998 }} onClick={pmReset} />
      <div ref={pmRef} className="bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-72" style={{ zIndex: 9999, position: "fixed", top: pmPos.top, left: pmPos.left, maxHeight: "80vh", overflowY: "auto" }}>
        {pmError && (
          <div className="p-3 border-b border-zinc-700/50">
            <p className="text-xs text-red-400">{pmError}</p>
            <button onClick={() => setPmError(null)} className="mt-1.5 text-xs text-zinc-500 hover:text-zinc-300">Dismiss</button>
          </div>
        )}
        {!pmType && !pmResult && !pmChargeResult && (
          <div className="p-2 space-y-0.5">
            <p className="px-2 py-1.5 text-xs font-medium text-zinc-400 uppercase tracking-wider">Generate Link</p>
            {[
              { key: "card_on_file", label: "Card on File", desc: "Send link to save card", icon: CreditCard },
              { key: "enter_card", label: "Enter Card", desc: "Type in card details", icon: KeyRound },
              { key: "payment", label: "Payment Link", desc: "Custom amount", icon: DollarSign },
              { key: "invoice", label: "Invoice", desc: "Email invoice", icon: FileText },
            ].map((opt) => (
              <button
                key={opt.key}
                onClick={() => {
                  setPmError(null)
                  if (opt.key === "enter_card") {
                    if (!pmGetCustomerId()) {
                      setPmError("No customer found — save a customer first before entering card details.")
                      return
                    }
                    pmReset()
                    setCardFormOpen(true)
                  } else if (opt.key === "payment") {
                    setPmType("payment")
                  } else if (opt.key === "invoice") {
                    // Need to pick a job first if event is open
                    if (selectedEvent) {
                      setPmJobId(selectedEvent.jobId)
                    }
                    setPmType("invoice")
                  } else if (opt.key === "card_on_file") {
                    if (!pmGetCustomerId()) {
                      setPmError("No customer found.")
                      return
                    }
                    if (!selectedEvent?.customerEmail) {
                      setPmError("Customer email required for card-on-file link. Add an email first via Edit.")
                      return
                    }
                    setPmType(opt.key)
                    pmGenerateLink(opt.key).then(ok => { if (!ok) setPmType(null) })
                  } else {
                    setPmType(opt.key)
                    pmGenerateLink(opt.key).then(ok => { if (!ok) setPmType(null) })
                  }
                }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left hover:bg-zinc-800 transition-colors"
              >
                <opt.icon className="w-4 h-4 text-purple-400 flex-shrink-0" />
                <div>
                  <div className="text-sm text-zinc-200">{opt.label}</div>
                  <div className="text-xs text-zinc-500">{opt.desc}</div>
                </div>
              </button>
            ))}
            {showCardOnFile && (
              <>
                <div className="mx-2 my-1.5 border-t border-zinc-700/50" />
                <p className="px-2 py-1.5 text-xs font-medium text-zinc-400 uppercase tracking-wider">Charge</p>
                <button
                  onClick={() => setPmType("charge_card")}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left hover:bg-zinc-800 transition-colors"
                >
                  <Zap className="w-4 h-4 text-amber-400 flex-shrink-0" />
                  <div>
                    <div className="text-sm text-zinc-200">Charge Card</div>
                    <div className="text-xs text-zinc-500">Charge saved card</div>
                  </div>
                </button>
              </>
            )}
          </div>
        )}

        {/* Payment Link — amount input */}
        {pmType === "payment" && !pmResult && (
          <div className="p-4 space-y-3">
            <p className="text-sm font-medium text-zinc-200">Payment Link</p>
            <input
              type="number"
              value={pmAmount}
              onChange={(e) => setPmAmount(e.target.value)}
              placeholder="Amount ($)"
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-purple-500"
              autoFocus
            />
            <div className="flex gap-2">
              <button onClick={() => setPmType(null)} className="flex-1 px-3 py-2 text-xs text-zinc-400 bg-zinc-800 rounded-lg hover:bg-zinc-700 transition-colors">Back</button>
              <button
                onClick={() => pmGenerateLink("payment")}
                disabled={pmLoading || !pmAmount || parseFloat(pmAmount) <= 0}
                className="flex-1 px-3 py-2 text-xs font-medium text-white bg-purple-600 rounded-lg hover:bg-purple-500 disabled:opacity-50 transition-colors"
              >
                {pmLoading ? "Generating..." : "Generate"}
              </button>
            </div>
          </div>
        )}

        {/* Invoice — confirm */}
        {pmType === "invoice" && !pmResult && (
          <div className="p-4 space-y-3">
            <p className="text-sm font-medium text-zinc-200">Send Invoice</p>
            <div className="flex gap-2">
              <button onClick={() => { setPmType(null); setPmJobId("") }} className="flex-1 px-3 py-2 text-xs text-zinc-400 bg-zinc-800 rounded-lg hover:bg-zinc-700 transition-colors">Back</button>
              <button
                onClick={() => pmGenerateLink("invoice")}
                disabled={pmLoading}
                className="flex-1 px-3 py-2 text-xs font-medium text-white bg-purple-600 rounded-lg hover:bg-purple-500 disabled:opacity-50 transition-colors"
              >
                {pmLoading ? "Sending..." : "Send Invoice"}
              </button>
            </div>
          </div>
        )}

        {/* Enter Card — Stripe Elements */}

        {/* Charge Card — amount input */}
        {pmType === "charge_card" && !pmChargeResult && (
          <div className="p-4 space-y-3">
            <p className="text-sm font-medium text-zinc-200">Charge Card on File</p>
            <input
              type="number"
              value={pmAmount}
              onChange={(e) => setPmAmount(e.target.value)}
              placeholder="Amount ($)"
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-amber-500"
              autoFocus
            />
            <input
              type="text"
              value={pmChargeDesc}
              onChange={(e) => setPmChargeDesc(e.target.value)}
              placeholder="Description (optional)"
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-amber-500"
            />
            <div className="flex gap-2">
              <button onClick={() => { setPmType(null); setPmAmount(""); setPmChargeDesc("") }} className="flex-1 px-3 py-2 text-xs text-zinc-400 bg-zinc-800 rounded-lg hover:bg-zinc-700 transition-colors">Back</button>
              <button
                onClick={pmChargeCard}
                disabled={pmChargeLoading || !pmAmount || parseFloat(pmAmount) <= 0}
                className="flex-1 px-3 py-2 text-xs font-medium text-white bg-amber-600 rounded-lg hover:bg-amber-500 disabled:opacity-50 transition-colors"
              >
                {pmChargeLoading ? "Charging..." : `Charge $${pmAmount || "0"}`}
              </button>
            </div>
          </div>
        )}

        {/* Charge Card — result */}
        {pmChargeResult && (
          <div className="p-4 space-y-3">
            {pmChargeResult.success ? (
              <>
                <p className="text-sm font-medium text-emerald-400">Charge Successful!</p>
                <p className="text-xs text-zinc-400">${pmChargeResult.amount?.toFixed(2)} charged to card on file. SMS receipt sent.</p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-red-400">Charge Failed</p>
                <p className="text-xs text-zinc-400">{pmChargeResult.error}</p>
              </>
            )}
            <button onClick={pmReset} className="w-full px-3 py-2 text-xs text-zinc-400 bg-zinc-800 rounded-lg hover:bg-zinc-700 transition-colors">Done</button>
          </div>
        )}

        {/* Loading state */}
        {pmType === "card_on_file" && !pmResult && pmLoading && (
          <div className="p-4 flex items-center justify-center gap-2 text-sm text-zinc-400">
            <Loader2 className="w-4 h-4 animate-spin" /> Generating...
          </div>
        )}

        {/* Result — URL + copy/SMS */}
        {pmResult && (
          <div className="p-4 space-y-3">
            <p className="text-sm font-medium text-emerald-400">
              {pmResult.invoiceId ? "Invoice Sent!" : "Link Generated!"}
            </p>
            {pmResult.url && (
              <>
                <div className="px-3 py-2 bg-zinc-800 rounded-lg text-xs text-zinc-300 break-all max-h-20 overflow-y-auto">
                  {pmResult.url}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={pmCopy}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg transition-colors"
                  >
                    {pmCopied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    {pmCopied ? "Copied" : "Copy"}
                  </button>
                  <button
                    onClick={pmSendSms}
                    disabled={pmSmsSending || pmSmsSent}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-white rounded-lg transition-colors ${pmSmsSent ? "bg-emerald-600" : "bg-purple-600 hover:bg-purple-500"} disabled:opacity-80`}
                  >
                    {pmSmsSending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : pmSmsSent ? <Check className="w-3.5 h-3.5" /> : <Send className="w-3.5 h-3.5" />}
                    {pmSmsSending ? "Sending..." : pmSmsSent ? "Sent" : "Send SMS"}
                  </button>
                </div>
              </>
            )}
            {pmResult.invoiceId && !pmResult.url && (
              <p className="text-xs text-zinc-400">Invoice emailed to customer.</p>
            )}
            <button onClick={pmReset} className="w-full px-3 py-2 text-xs text-zinc-400 bg-zinc-800 rounded-lg hover:bg-zinc-700 transition-colors">Done</button>
          </div>
        )}
      </div>
    </>
    )
    return typeof document !== "undefined" ? createPortal(content, document.body) : null
  }

  return (
    <>
      <div className="calendar-shell animate-fade-in">
        <div className="mb-3 stagger-1 flex flex-col sm:flex-row sm:items-center justify-between gap-2" style={{ flexShrink: 0 }}>
          <div>
            <h1 className="text-xl md:text-2xl font-semibold text-foreground">Calendar</h1>
            <p className="text-xs md:text-sm text-muted-foreground">
              {isAdmin ? "Schedule and manage appointments" : "Your schedule at a glance"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* +New Quote stays on Calendar so admins / team leads can mint
                a quote without first hopping to the Command Center. Field
                roles still have their own +New Quote on /my-day. */}
            {showNewQuoteButton && (
              <button
                onClick={startNewQuote}
                disabled={creatingQuoteDraft}
                className="flex items-center gap-1.5 rounded-md bg-teal-500 px-3 py-1.5 text-xs md:text-sm font-semibold text-white shadow-sm hover:bg-teal-600 transition-colors disabled:opacity-60"
              >
                {creatingQuoteDraft ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                New Quote
              </button>
            )}
            {canEditCalendar && (
              <button className="rain-day-btn text-xs md:text-sm" onClick={openRainDay}>
                Rainy Day Reschedule
              </button>
            )}
          </div>
        </div>

        {/* Clock widget moved to /my-day Command Center. Calendar is now a
            high-level overview only (per Dominic 2026-04-26). */}

        {loading ? <CubeLoader /> : <>
        {/* Schedule monitoring strip — at-a-glance daily summary */}
        {(() => {
          const today = new Date().toISOString().split("T")[0]
          const todayJobs = visibleJobs.filter(j => {
            const jobDate = j.date || j.scheduled_date || ""
            return jobDate.startsWith(today)
          })
          const totalScheduled = todayJobs.length
          const completed = todayJobs.filter(j => j.status === "completed").length
          const inProgress = todayJobs.filter(j => j.status === "in_progress").length
          const unassigned = todayJobs.filter(j => !j.cleaner_id).length
          const totalRevenue = todayJobs.reduce((sum, j) => sum + (Number(j.price) || Number(j.estimated_value) || 0), 0)

          return totalScheduled > 0 ? (
            <div className="flex items-center gap-4 mb-3 px-3 py-2 rounded-xl border border-border/30 bg-card/30 text-sm" style={{ flexShrink: 0 }}>
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground">Today:</span>
                <span className="font-semibold text-foreground">{totalScheduled} jobs</span>
              </div>
              <div className="h-4 w-px bg-border/50" />
              {completed > 0 && (
                <div className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-green-500" />
                  <span className="text-green-400">{completed} done</span>
                </div>
              )}
              {inProgress > 0 && (
                <div className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-yellow-500" />
                  <span className="text-yellow-400">{inProgress} active</span>
                </div>
              )}
              {unassigned > 0 && (
                <div className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-red-500" />
                  <span className="text-red-400">{unassigned} unassigned</span>
                </div>
              )}
              <div className="h-4 w-px bg-border/50" />
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground">Revenue:</span>
                <span className="font-semibold text-violet-400">${totalRevenue.toLocaleString()}</span>
              </div>
            </div>
          ) : null
        })()}

        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", marginBottom: "0.75rem", minHeight: 0, flexShrink: 0 }}>
          {cleanerColorMap.size >= 2 && [...cleanerColorMap.entries()].map(([name, color]) => {
            const isHidden = hiddenCleaners.has(name)
            return (
              <button
                key={name}
                className="animate-fade-in cursor-pointer"
                style={{ display: "flex", alignItems: "center", gap: "0.375rem", opacity: isHidden ? 0.3 : 1, transition: "opacity 0.2s" }}
                onClick={() => setHiddenCleaners(prev => {
                  const next = new Set(prev)
                  if (next.has(name)) next.delete(name)
                  else next.add(name)
                  return next
                })}
                title={isHidden ? `Show ${name}` : `Hide ${name}`}
              >
                <span style={{
                  width: 12,
                  height: 12,
                  borderRadius: 3,
                  backgroundColor: color,
                  display: "inline-block",
                  flexShrink: 0,
                }} />
                <span style={{ fontSize: "0.8rem", color: isHidden ? "#52525b" : "#a1a1aa" }}>{name}</span>
              </button>
            )
          })}
        </div>

        <div className="calendar-card">
          {ganttView ? (
            <div id="calendar" style={{ padding: 16 }}>
              <ScheduleGantt
                jobs={ganttJobs}
                cleanerColorMap={cleanerColorMap}
                onJobClick={handleGanttJobClick}
              />
            </div>
          ) : (
          <div id="calendar">
            <FullCalendar
              ref={calendarRef}
              plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
              initialView={getSavedView()}
              initialDate={getSavedDate()}
              height="100%"
              headerToolbar={
                typeof window !== "undefined" && window.innerWidth < 768
                  ? { left: "prev,next", center: "title", right: "listMonth,dayGridMonth" }
                  : { left: "prev,next today", center: "title", right: "dayGridMonth,timeGridWeek,listMonth" }
              }
              slotMinTime="07:00:00"
              slotMaxTime="21:00:00"
              slotDuration="00:30:00"
              allDaySlot={false}
              expandRows
              slotLabelFormat={{ hour: "numeric", minute: "2-digit", meridiem: "short" }}
              dayHeaderFormat={{ weekday: "short", month: "numeric", day: "numeric" }}
              events={hiddenCleaners.size > 0 ? baseEvents.filter(e => !hiddenCleaners.has((e.extendedProps as any)?.cleanerName || '')) : baseEvents}
              editable={canEditCalendar}
              selectable={canEditCalendar}
              nowIndicator
              fixedWeekCount={false}
              dayMaxEvents={false}
              eventDurationEditable={false}
              snapDuration="00:15:00"
              dragRevertDuration={0}
              eventTimeFormat={timeFormat}
              eventContent={(arg) => {
                const price = arg.event.extendedProps.price
                const status = arg.event.extendedProps.status
                const service = arg.event.extendedProps.service
                const salesmanName = arg.event.extendedProps.salesmanName || ''
                const cleanerName = arg.event.extendedProps.cleanerName || ''
                const view = arg.view.type
                const dotColor = status === 'completed' ? '#22c55e' : status === 'in_progress' ? '#f59e0b' : '#6366f1'
                const soldBadge = salesmanName
                  ? `<span style="font-size:8px;background:rgba(245,158,11,0.15);color:#f59e0b;padding:0 3px;border-radius:3px;font-weight:500;white-space:nowrap">Sold: ${salesmanName.split(' ')[0]}</span>`
                  : ''
                const crewBadge = cleanerName
                  ? `<span style="font-size:8px;background:rgba(59,130,246,0.15);color:#60a5fa;padding:0 3px;border-radius:3px;font-weight:500;white-space:nowrap">Crew: ${cleanerName.split(' ')[0]}</span>`
                  : ''
                if (view === 'dayGridMonth') {
                  const timeText = arg.timeText || ''
                  return {
                    html: `
                      <div style="display:flex;align-items:center;gap:3px;padding:1px 3px;overflow:hidden;white-space:nowrap">
                        <span style="font-size:10px;opacity:0.75;flex-shrink:0">${timeText}</span>
                        <span style="font-weight:600;font-size:11px;overflow:hidden;text-overflow:ellipsis">${arg.event.title}</span>
                        ${soldBadge}
                      </div>
                    `
                  }
                }
                if (view !== 'timeGridWeek' && view !== 'timeGridDay') return undefined
                return {
                  html: `
                    <div style="padding:1px 3px;overflow:hidden;line-height:1.3">
                      <div style="display:flex;align-items:center;gap:3px">
                        <span style="width:6px;height:6px;border-radius:50%;background:${dotColor};flex-shrink:0"></span>
                        <span style="font-weight:600;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${arg.event.title}</span>
                      </div>
                      <div style="display:flex;gap:4px;font-size:10px;opacity:0.85;margin-top:1px;flex-wrap:wrap">
                        ${price ? `<span style="font-weight:500">$${Number(price).toLocaleString()}</span>` : ''}
                        ${service ? `<span style="opacity:0.7">${service}</span>` : ''}
                      </div>
                      ${(soldBadge || crewBadge) ? `<div style="display:flex;gap:3px;margin-top:1px;flex-wrap:wrap">${soldBadge}${crewBadge}</div>` : ''}
                    </div>
                  `
                }
              }}
              select={handleSelect}
              eventClick={handleEventClick}
              eventDrop={handleEventDrop}
              datesSet={(info) => {
                setActiveFcView(info.view.type)
                localStorage.setItem(STORAGE_KEY_VIEW, info.view.type)
                localStorage.setItem(STORAGE_KEY_DATE, info.start.toISOString())
              }}
              eventDidMount={(info) => {
                const titleEl = info.el.querySelector(".fc-event-title, .fc-list-event-title")
                if (titleEl) {
                  if (isHouseCleaning) {
                    // Commercial/Residential badge — house cleaning tenants only
                    const typeBadge = document.createElement("span")
                    typeBadge.textContent = info.event.extendedProps.isCommercial ? " \uD83C\uDFE2" : " \uD83C\uDFE0"
                    typeBadge.title = info.event.extendedProps.isCommercial ? "Commercial" : "Residential"
                    typeBadge.style.cssText = "font-size:0.75em;"
                    titleEl.appendChild(typeBadge)
                  }

                  // Recurring badge
                  const freq = info.event.extendedProps.frequency || "one-time"
                  if (freq !== "one-time") {
                    const recurBadge = document.createElement("span")
                    recurBadge.textContent = " \u21BB"
                    recurBadge.title = `Recurring: ${freq}`
                    recurBadge.style.cssText = "font-size:0.7em;opacity:0.7;"
                    titleEl.appendChild(recurBadge)
                  }

                  // Sold by badge (list view)
                  const smName = info.event.extendedProps.salesmanName
                  if (smName) {
                    const soldBadge = document.createElement("span")
                    soldBadge.textContent = ` Sold: ${smName.split(' ')[0]}`
                    soldBadge.style.cssText = "font-size:0.65em;font-weight:600;margin-left:4px;padding:1px 4px;border-radius:4px;background:rgba(245,158,11,0.15);color:#f59e0b;"
                    titleEl.appendChild(soldBadge)
                  }

                  // Crew badge (list view)
                  const crName = info.event.extendedProps.cleanerName
                  if (crName) {
                    const crewBadge = document.createElement("span")
                    crewBadge.textContent = ` Crew: ${crName.split(' ')[0]}`
                    crewBadge.style.cssText = "font-size:0.65em;font-weight:600;margin-left:4px;padding:1px 4px;border-radius:4px;background:rgba(59,130,246,0.15);color:#60a5fa;"
                    titleEl.appendChild(crewBadge)
                  }
                }
                const service = info.event.extendedProps.service || ""
                const loc = info.event.extendedProps.location || ""
                const tip = [service, loc].filter(Boolean).join(" \u2022 ")
                if (tip) {
                  info.el.setAttribute("title", tip)
                }
              }}
            />
          </div>
          )}
          {/* Custom view switcher — positioned over FullCalendar toolbar */}
          <div className="gantt-view-switcher">
            {([
              ["dayGridMonth", "Month"],
              ["timeGridWeek", "Week"],
              ["gantt", "Day"],
              ["listMonth", "List"],
            ] as const).map(([view, label]) => {
              const isActive = view === "gantt" ? ganttView : (!ganttView && activeFcView === view)
              return (
                <button
                  key={view}
                  className={`gantt-view-btn${isActive ? " gantt-view-btn-active" : ""}`}
                  onClick={() => {
                    if (view === "gantt") {
                      setGanttView(true)
                      localStorage.setItem(STORAGE_KEY_VIEW, "gantt")
                    } else {
                      setGanttView(false)
                      setActiveFcView(view)
                      localStorage.setItem(STORAGE_KEY_VIEW, view)
                      // FullCalendar re-mounts with initialView, but if already mounted change view
                      setTimeout(() => calendarRef.current?.getApi()?.changeView(view), 0)
                    }
                  }}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>
        </>}
      </div>

      {/* Event Details Modal */}
      <div
        className={`cal-modal-backdrop${selectedEvent ? " open" : ""}`}
        onClick={(e) => {
          if (e.target === e.currentTarget) { setSelectedEvent(null); setConfirmDelete(false); setDeleteMode(null) }
        }}
      >
        <div className="cal-modal">
          <div className="cal-modal-header">
            <h5>{selectedEvent?.title || "Event"}</h5>
            <button
              className="cal-modal-close"
              onClick={() => { setSelectedEvent(null); setConfirmDelete(false); setDeleteMode(null) }}
            >
              &times;
            </button>
          </div>
          <div className="cal-modal-body">
            {!editMode ? (
              <>
                <div style={{ marginBottom: "0.5rem" }}>
                  <strong>When:</strong>{" "}
                  {formatRange(selectedEvent?.start || null, selectedEvent?.end || null)}
                </div>
                <div style={{ marginBottom: "0.5rem", display: "flex", alignItems: "center", gap: 6 }}>
                  <strong>Customer:</strong>{" "}
                  {selectedEvent?.customerPhone ? (
                    <span
                      style={{ color: "#8b5cf6", cursor: "pointer", textDecoration: "underline" }}
                      onClick={() => router.push(`/customers?phone=${encodeURIComponent(selectedEvent.customerPhone)}`)}
                    >
                      {selectedEvent?.client || emptyValue}
                    </span>
                  ) : (
                    selectedEvent?.client || emptyValue
                  )}
                  {selectedEvent?.cardOnFile && (
                    <span style={{
                      display: "inline-flex",
                      alignItems: "center",
                      padding: "1px 6px",
                      borderRadius: 4,
                      fontSize: "0.65rem",
                      fontWeight: 600,
                      background: "rgba(16, 185, 129, 0.12)",
                      color: "#34d399",
                      border: "1px solid rgba(16, 185, 129, 0.2)",
                    }}>Card on file</span>
                  )}
                </div>
                {selectedEvent?.customerPhone && (
                  <div style={{ marginBottom: "0.5rem" }}>
                    <strong>Phone:</strong>{" "}
                    <a href={`tel:${selectedEvent.customerPhone}`} style={{ color: "#8b5cf6", textDecoration: "none" }}>
                      {selectedEvent.customerPhone}
                    </a>
                  </div>
                )}
                {selectedEvent?.customerEmail && (
                  <div style={{ marginBottom: "0.5rem" }}>
                    <strong>Email:</strong>{" "}
                    <a href={`mailto:${selectedEvent.customerEmail}`} style={{ color: "#8b5cf6", textDecoration: "none" }}>
                      {selectedEvent.customerEmail}
                    </a>
                  </div>
                )}
                {selectedEvent?.leadSource && (() => {
                  const cfg = getLeadSourceConfig(selectedEvent.leadSource)
                  return (
                    <div style={{ marginBottom: "0.5rem", display: "flex", alignItems: "center", gap: 6 }}>
                      <strong>Source:</strong>
                      <span style={{
                        display: "inline-flex",
                        alignItems: "center",
                        padding: "2px 8px",
                        borderRadius: 8,
                        fontSize: "0.7rem",
                        fontWeight: 600,
                        backgroundColor: cfg.color,
                        color: "#fff",
                      }}>{cfg.label}</span>
                    </div>
                  )
                })()}
                {selectedEvent?.service && (
                  <div style={{ marginBottom: "0.5rem" }}>
                    <strong>Service:</strong> {selectedEvent.service}
                  </div>
                )}
                {selectedEvent?.frequency && selectedEvent.frequency !== "one-time" && (
                  <div style={{ marginBottom: "0.5rem", display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{
                      display: "inline-flex",
                      alignItems: "center",
                      padding: "1px 6px",
                      borderRadius: 4,
                      fontSize: "0.65rem",
                      fontWeight: 600,
                      background: "rgba(139, 92, 246, 0.12)",
                      color: "#a78bfa",
                      border: "1px solid rgba(139, 92, 246, 0.2)",
                    }}>
                      &#8635; {selectedEvent.frequency.replace("-", "-")}
                    </span>
                    {selectedEvent.parentJobId && (
                      <span style={{ fontSize: "0.65rem", color: "#71717a" }}>
                        (instance of series #{selectedEvent.parentJobId})
                      </span>
                    )}
                  </div>
                )}
                <div style={{ marginBottom: "0.5rem", display: "flex", alignItems: "center", gap: 6 }}>
                  <strong>Crew:</strong>{" "}
                  <span style={{
                    display: "inline-flex",
                    alignItems: "center",
                    padding: "2px 8px",
                    borderRadius: 8,
                    fontSize: "0.7rem",
                    fontWeight: 600,
                    backgroundColor: "rgba(59, 130, 246, 0.15)",
                    color: "#60a5fa",
                    border: "1px solid rgba(59, 130, 246, 0.25)",
                  }}>{selectedEvent?.cleaner || "Unassigned"}</span>
                </div>
                {selectedEvent?.salesmanName && (
                  <div style={{ marginBottom: "0.5rem", display: "flex", alignItems: "center", gap: 6 }}>
                    <strong>Sold by:</strong>{" "}
                    <span style={{
                      display: "inline-flex",
                      alignItems: "center",
                      padding: "2px 8px",
                      borderRadius: 8,
                      fontSize: "0.7rem",
                      fontWeight: 600,
                      backgroundColor: "rgba(245, 158, 11, 0.15)",
                      color: "#fbbf24",
                      border: "1px solid rgba(245, 158, 11, 0.25)",
                    }}>{selectedEvent.salesmanName}</span>
                  </div>
                )}
                {selectedEvent?.team && (
                  <div style={{ marginBottom: "0.5rem" }}>
                    <strong>Team:</strong> {selectedEvent.team}
                  </div>
                )}
                <div style={{ marginBottom: "0.5rem" }}>
                  <strong>Location:</strong> {selectedEvent?.location || emptyValue}
                </div>
                <div style={{ marginBottom: "0.5rem" }}>
                  <strong>Status:</strong> {selectedEvent?.status || emptyValue}
                </div>
                {selectedEvent?.price ? (
                  <div style={{ marginBottom: "0.5rem" }}>
                    <strong>Price:</strong> ${Number(selectedEvent.price)}
                  </div>
                ) : null}
                {selectedEvent?.notes && (
                  <div>
                    <strong>Notes:</strong> {selectedEvent.notes}
                  </div>
                )}
                {/* Auto-schedule button for unscheduled cleaning jobs */}
                {selectedEvent?.jobType === 'cleaning' && !selectedEvent?.start && (selectedEvent?.status === 'pending' || selectedEvent?.status === 'scheduled') && (
                  <div style={{ marginTop: "1rem", padding: "0.75rem", borderRadius: 8, background: "rgba(59, 130, 246, 0.08)", border: "1px solid rgba(59, 130, 246, 0.2)" }}>
                    <div style={{ fontSize: "0.8rem", color: "#93c5fd", marginBottom: "0.5rem" }}>
                      This cleaning job has no date set.
                    </div>
                    <button
                      onClick={handleAutoSchedule}
                      disabled={autoScheduling}
                      style={{
                        width: "100%",
                        padding: "0.5rem 1rem",
                        borderRadius: 6,
                        border: "none",
                        background: "linear-gradient(135deg, #3b82f6, #2563eb)",
                        color: "#fff",
                        fontWeight: 600,
                        fontSize: "0.85rem",
                        cursor: autoScheduling ? "not-allowed" : "pointer",
                        opacity: autoScheduling ? 0.7 : 1,
                      }}
                    >
                      {autoScheduling ? "Finding best slot..." : "Auto-schedule soonest"}
                    </button>
                    {autoScheduleResult && (
                      <div style={{
                        marginTop: "0.5rem",
                        fontSize: "0.8rem",
                        color: autoScheduleResult.startsWith('Error') ? "#f87171" : "#34d399",
                      }}>
                        {autoScheduleResult}
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <>
                {/* Scheduling */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem", marginBottom: "0.5rem" }}>
                  <div>
                    <label className="cal-form-label">Date</label>
                    <input type="date" className="cal-form-control" value={editForm.date} onChange={(e) => setEditForm((f) => ({ ...f, date: e.target.value }))} />
                  </div>
                  <div>
                    <label className="cal-form-label">Time</label>
                    <input type="time" className="cal-form-control" value={editForm.time} onChange={(e) => setEditForm((f) => ({ ...f, time: e.target.value }))} />
                  </div>
                </div>
                <div style={{ marginBottom: "0.5rem", position: "relative" }} ref={cleanerDropdownRef}>
                  <label className="cal-form-label">Assigned Cleaners</label>
                  <div
                    onClick={() => setCleanerDropdownOpen(!cleanerDropdownOpen)}
                    className="cal-form-control"
                    style={{ cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", minHeight: "2.2rem", gap: "0.25rem", flexWrap: "wrap" }}
                  >
                    {editForm.cleanerIds.length === 0 ? (
                      <span style={{ color: "#71717a" }}>— Select cleaners —</span>
                    ) : (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem" }}>
                        {editForm.cleanerIds.map(id => {
                          const c = cleanersList.find(cl => cl.id === id)
                          return c ? (
                            <span key={id} style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "rgba(16, 185, 129, 0.15)", color: "#6ee7b7", padding: "1px 8px", borderRadius: 12, fontSize: "0.75rem", fontWeight: 500 }}>
                              {c.name}
                              <span
                                onClick={(e) => { e.stopPropagation(); setEditForm(f => ({ ...f, cleanerIds: f.cleanerIds.filter(x => x !== id) })) }}
                                style={{ cursor: "pointer", opacity: 0.7, fontSize: "0.85rem", lineHeight: 1 }}
                              >×</span>
                            </span>
                          ) : null
                        })}
                      </div>
                    )}
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ flexShrink: 0, transform: cleanerDropdownOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
                      <path d="M2.5 4.5L6 8L9.5 4.5" stroke="#71717a" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </div>
                  {cleanerDropdownOpen && (
                    <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 50, marginTop: 4, background: "#1c1c1e", border: "1px solid #333", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.4)", maxHeight: 200, overflowY: "auto" }}>
                      {cleanersList.map((c) => {
                        const checked = editForm.cleanerIds.includes(c.id)
                        return (
                          <label
                            key={c.id}
                            style={{ display: "flex", alignItems: "center", gap: 8, padding: "0.45rem 0.75rem", cursor: "pointer", fontSize: "0.8rem", color: "#e4e4e7", background: checked ? "rgba(16, 185, 129, 0.1)" : "transparent", transition: "background 0.1s" }}
                            onMouseEnter={(e) => { if (!checked) (e.currentTarget.style.background = "rgba(255,255,255,0.04)") }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = checked ? "rgba(16, 185, 129, 0.1)" : "transparent" }}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => {
                                setEditForm(f => ({
                                  ...f,
                                  cleanerIds: checked
                                    ? f.cleanerIds.filter(id => id !== c.id)
                                    : [...f.cleanerIds, c.id]
                                }))
                              }}
                              style={{ accentColor: "#10b981", width: 14, height: 14 }}
                            />
                            {c.name}
                          </label>
                        )
                      })}
                      {cleanersList.length === 0 && (
                        <div style={{ padding: "0.75rem", fontSize: "0.8rem", color: "#71717a", textAlign: "center" }}>No cleaners available</div>
                      )}
                    </div>
                  )}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem", marginBottom: "0.5rem" }}>
                  <div>
                    <label className="cal-form-label">Status</label>
                    <select className="cal-form-control" value={editForm.status} onChange={(e) => setEditForm((f) => ({ ...f, status: e.target.value }))}>
                      {["pending", "scheduled", "in_progress", "completed", "cancelled", "quoted"].map((s) => (
                        <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="cal-form-label">Price</label>
                    <input type="number" className="cal-form-control" placeholder="0.00" step="0.01" value={editForm.price} onChange={(e) => setEditForm((f) => ({ ...f, price: e.target.value }))} />
                  </div>
                </div>
                {/* Customer info */}
                <div style={{ marginBottom: "0.5rem" }}>
                  <label className="cal-form-label">Customer Name</label>
                  <input type="text" className="cal-form-control" value={editForm.customerName} onChange={(e) => setEditForm((f) => ({ ...f, customerName: e.target.value }))} />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem", marginBottom: "0.5rem" }}>
                  <div>
                    <label className="cal-form-label">Phone</label>
                    <input type="tel" className="cal-form-control" value={editForm.customerPhone} onChange={(e) => setEditForm((f) => ({ ...f, customerPhone: e.target.value }))} />
                  </div>
                  <div>
                    <label className="cal-form-label">Email</label>
                    <input type="email" className="cal-form-control" value={editForm.customerEmail} onChange={(e) => setEditForm((f) => ({ ...f, customerEmail: e.target.value }))} />
                  </div>
                </div>
                <div style={{ marginBottom: "0.5rem" }}>
                  <label className="cal-form-label">Address</label>
                  <input type="text" className="cal-form-control" value={editForm.address} onChange={(e) => setEditForm((f) => ({ ...f, address: e.target.value }))} />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem", marginBottom: "0.5rem" }}>
                  <div>
                    <label className="cal-form-label">Service Type</label>
                    <input type="text" className="cal-form-control" value={editForm.serviceType} onChange={(e) => setEditForm((f) => ({ ...f, serviceType: e.target.value }))} />
                  </div>
                  <div>
                    <label className="cal-form-label">Duration</label>
                    <div style={{ fontSize: "0.8rem", color: "#71717a", padding: "0.45rem 0" }}>{selectedEvent?.hours || 2} hours</div>
                  </div>
                </div>
                <div style={{ marginBottom: "0.5rem" }}>
                  <label className="cal-form-label">Notes</label>
                  <textarea className="cal-form-control" rows={2} value={editForm.notes} onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))} style={{ resize: "vertical" }} />
                </div>
              </>
            )}
          </div>
          <div className="cal-modal-footer">
            {confirmDelete ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", width: "100%" }}>
                {selectedEvent && (selectedEvent.frequency !== "one-time" || selectedEvent.parentJobId) ? (
                  <>
                    <span style={{ fontSize: "0.85rem", color: "#ef4444" }}>This is a recurring job. What do you want to delete?</span>
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      <button
                        className="cal-modal-btn"
                        onClick={() => { setConfirmDelete(false); setDeleteMode(null) }}
                        disabled={saving}
                      >
                        Cancel
                      </button>
                      <button
                        className="cal-modal-btn"
                        onClick={() => handleDeleteJob("single")}
                        disabled={saving}
                        style={{ color: "#ef4444", borderColor: "#ef4444" }}
                      >
                        {saving && deleteMode === "single" ? <><span className="saving-spinner" /> Deleting...</> : "Just this one"}
                      </button>
                      <button
                        className="cal-modal-btn"
                        onClick={() => { setDeleteMode("future"); handleDeleteJob("future") }}
                        disabled={saving}
                        style={{ color: "#fff", backgroundColor: "#ef4444", borderColor: "#ef4444" }}
                      >
                        {saving && deleteMode === "future" ? <><span className="saving-spinner" /> Deleting all...</> : "This & all future"}
                      </button>
                    </div>
                  </>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <span style={{ fontSize: "0.85rem", color: "#ef4444" }}>Delete this job?</span>
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      <button
                        className="cal-modal-btn"
                        onClick={() => setConfirmDelete(false)}
                        disabled={saving}
                      >
                        Cancel
                      </button>
                      <button
                        className="cal-modal-btn"
                        onClick={() => handleDeleteJob("single")}
                        disabled={saving}
                        style={{ color: "#ef4444", borderColor: "#ef4444" }}
                      >
                        {saving ? <><span className="saving-spinner" /> Deleting...</> : "Yes, delete"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : addChargeOpen ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", width: "100%" }}>
                <span style={{ fontSize: "0.85rem", fontWeight: 500 }}>Add Charge</span>
                {/* Preset add-ons from pricing table */}
                {addonsList.filter(a => a.flat_price && a.flat_price > 0).length > 0 && (
                  <select
                    value={addChargeType === "custom" ? "" : addChargeType}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v) {
                        setAddChargeType(v)
                        setAddChargeAmount("")
                        setAddChargeDesc("")
                      }
                    }}
                    style={{ padding: "0.35rem 0.5rem", borderRadius: 6, border: "1px solid #3f3f46", background: "#18181b", color: "#e4e4e7", fontSize: "0.85rem" }}
                  >
                    <option value="">Quick add-on...</option>
                    {addonsList.filter(a => a.flat_price && a.flat_price > 0).map(a => (
                      <option key={a.addon_key} value={a.addon_key}>{a.label} (${a.flat_price})</option>
                    ))}
                  </select>
                )}
                {/* Divider */}
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.75rem", color: "#71717a" }}>
                  <div style={{ flex: 1, height: 1, background: "#3f3f46" }} />
                  or custom amount
                  <div style={{ flex: 1, height: 1, background: "#3f3f46" }} />
                </div>
                {/* Custom amount — always visible */}
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <div style={{ position: "relative", width: 100 }}>
                    <span style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", color: "#71717a", fontSize: "0.85rem", pointerEvents: "none" }}>$</span>
                    <input
                      type="number"
                      placeholder="0.00"
                      value={addChargeAmount}
                      onChange={(e) => { setAddChargeAmount(e.target.value); if (e.target.value) setAddChargeType("custom") }}
                      style={{ width: "100%", padding: "0.35rem 0.5rem 0.35rem 1.2rem", borderRadius: 6, border: "1px solid #3f3f46", background: "#18181b", color: "#e4e4e7", fontSize: "0.85rem" }}
                    />
                  </div>
                  <input
                    placeholder="Description (e.g. Extra deep clean)"
                    value={addChargeDesc}
                    onChange={(e) => { setAddChargeDesc(e.target.value); if (!addChargeType) setAddChargeType("custom") }}
                    style={{ flex: 1, padding: "0.35rem 0.5rem", borderRadius: 6, border: "1px solid #3f3f46", background: "#18181b", color: "#e4e4e7", fontSize: "0.85rem" }}
                  />
                </div>
                <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
                  <button className="cal-modal-btn" onClick={() => setAddChargeOpen(false)} disabled={addChargeSaving}>Cancel</button>
                  <button
                    className="cal-modal-btn cal-modal-btn-primary"
                    onClick={handleAddCharge}
                    disabled={addChargeSaving || !addChargeType || (addChargeType === "custom" && !addChargeAmount)}
                  >
                    {addChargeSaving ? <><span className="saving-spinner" /> Adding...</> : "Add Charge"}
                  </button>
                </div>
              </div>
            ) : !editMode ? (
              <div style={{ display: "flex", justifyContent: "space-between", width: "100%" }}>
                <button
                  className="cal-modal-btn"
                  onClick={() => setConfirmDelete(true)}
                  title="Delete job"
                  style={{ color: "#ef4444", borderColor: "#ef4444", padding: "0.4rem 0.65rem" }}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                    <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/>
                    <path fillRule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/>
                  </svg>
                </button>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  {selectedEvent?.status !== "completed" && (
                    <button
                      className="cal-modal-btn"
                      onClick={() => setAddChargeOpen(true)}
                      title="Add on-site charge"
                      style={{ fontSize: "0.8rem" }}
                    >
                      + Charge
                    </button>
                  )}
                  <button
                    ref={pmBtnRef}
                    onClick={() => pmToggle(selectedEvent?.jobId)}
                    className={`cal-modal-btn ${pmOpen ? "text-purple-400" : ""}`}
                    title="Payment links"
                    style={{ padding: "0.4rem 0.5rem" }}
                  >
                    <DollarSign className="w-4 h-4" />
                  </button>
                  <button
                    className="cal-modal-btn"
                    onClick={() => {
                      if (selectedEvent?.jobId) {
                        setDrawerJobId(selectedEvent.jobId)
                        setSelectedEvent(null)
                      }
                    }}
                    title="View full job/visit details"
                    style={{ fontSize: "0.8rem" }}
                  >
                    Full Details
                  </button>
                  <button
                    className="cal-modal-btn cal-modal-btn-edit"
                    onClick={handleStartEdit}
                  >
                    Edit
                  </button>
                  <button
                    className="cal-modal-btn"
                    onClick={() => setSelectedEvent(null)}
                  >
                    Close
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", justifyContent: "space-between", width: "100%" }}>
                <button
                  className="cal-modal-btn"
                  onClick={() => setConfirmDelete(true)}
                  title="Delete job"
                  style={{ color: "#ef4444", borderColor: "#ef4444", padding: "0.4rem 0.65rem" }}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                    <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/>
                    <path fillRule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/>
                  </svg>
                </button>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <button
                    className="cal-modal-btn"
                    onClick={() => setEditMode(false)}
                  >
                    Cancel
                  </button>
                  <button
                    className="cal-modal-btn cal-modal-btn-primary"
                    onClick={handleEditSave}
                    disabled={saving || !editForm.date || !editForm.time}
                  >
                    {saving ? <><span className="saving-spinner" /> Saving...</> : "Save Changes"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Conflict Confirmation Dialog */}
      <div
        className={`cal-modal-backdrop${pendingMove ? " open" : ""}`}
        onClick={(e) => {
          if (e.target === e.currentTarget) handleCancelMove()
        }}
        style={{ zIndex: 60 }}
      >
        <div className="cal-modal" style={{ maxWidth: 440 }}>
          <div className="cal-modal-header">
            <h5>Schedule Conflict</h5>
            <button
              className="cal-modal-close"
              onClick={handleCancelMove}
            >
              &times;
            </button>
          </div>
          <div className="cal-modal-body">
            <p style={{ marginBottom: "0.75rem", color: "#d4d4d8" }}>
              <strong>{pendingMove?.cleanerName}</strong> already has a job scheduled at this time.
              If you continue, the overlapping job will be automatically rescheduled.
            </p>
            {pendingMove && (
              <div className="conflict-info">
                <div className="conflict-info-label">Overlapping Job</div>
                <div className="conflict-info-title">{pendingMove.conflictTitle}</div>
                <div className="conflict-info-time">
                  {formatRange(pendingMove.conflictStart, pendingMove.conflictEnd)}
                </div>
              </div>
            )}
          </div>
          <div className="cal-modal-footer">
            <button
              className="cal-modal-btn"
              onClick={handleCancelMove}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              className="cal-modal-btn cal-modal-btn-warning"
              onClick={handleConfirmMove}
              disabled={saving}
            >
              {saving ? <><span className="saving-spinner" /> Saving...</> : "Continue"}
            </button>
          </div>
        </div>
      </div>

      {/* Rainy Day Reschedule Modal */}
      <div
        className={`cal-modal-backdrop${rainOpen ? " open" : ""}`}
        onClick={(e) => {
          if (e.target === e.currentTarget) setRainOpen(false)
        }}
      >
        <div className="cal-modal" style={{ maxWidth: 520 }}>
          <div className="cal-modal-header">
            <h5>Rainy Day Reschedule</h5>
            <button className="cal-modal-close" onClick={() => setRainOpen(false)}>
              &times;
            </button>
          </div>
          <div className="cal-modal-body">
            {rainStep === "select" && (
              <>
                <p style={{ marginBottom: "0.75rem", color: "rgba(161,161,170,1)" }}>
                  Select the date to cancel. All jobs will be automatically spread across the next available days.
                </p>
                <label className="cal-form-label">Rain Date</label>
                <input
                  type="date"
                  className="cal-form-control"
                  value={rainDate}
                  onChange={(e) => setRainDate(e.target.value)}
                />
                {rainError && <p className="rain-error">{rainError}</p>}
              </>
            )}

            {rainStep === "preview" && rainPreview && (
              <>
                <div className="rain-summary">
                  <div className="rain-stat">
                    <span className="rain-stat-value">{rainPreview.jobs_count}</span>
                    <span className="rain-stat-label">Jobs Affected</span>
                  </div>
                  <div className="rain-stat">
                    <span className="rain-stat-value">
                      ${rainPreview.total_revenue.toLocaleString()}
                    </span>
                    <span className="rain-stat-label">Revenue at Risk</span>
                  </div>
                </div>
                {rainPreview.jobs.length > 0 && (
                  <div className="rain-job-list">
                    {rainPreview.jobs.map((j) => (
                      <div key={j.id} className="rain-job-row">
                        <span className="rain-job-name">{j.customer_name}</span>
                        <span className="rain-job-time">{j.time || "9:00 AM"}</span>
                        {j.value > 0 && (
                          <span className="rain-job-value">${j.value}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {rainPreview.jobs_count === 0 && (
                  <p style={{ color: "rgba(161,161,170,1)", textAlign: "center", padding: "1rem 0" }}>
                    No jobs found on this date.
                  </p>
                )}
                {rainError && <p className="rain-error">{rainError}</p>}
              </>
            )}

            {rainStep === "loading" && (
              <div style={{ textAlign: "center", padding: "2rem 0" }}>
                <div className="rain-spinner" />
                <p style={{ color: "rgba(161,161,170,1)", marginTop: "0.75rem" }}>
                  Rescheduling jobs and sending notifications...
                </p>
              </div>
            )}

            {rainStep === "done" && rainResult && (
              <>
                <div className="rain-summary">
                  <div className="rain-stat">
                    <span className="rain-stat-value">{rainResult.jobs_successfully_rescheduled}</span>
                    <span className="rain-stat-label">Jobs Moved</span>
                  </div>
                  <div className="rain-stat">
                    <span className="rain-stat-value">{rainResult.notifications_sent}</span>
                    <span className="rain-stat-label">Notifications Sent</span>
                  </div>
                </div>
                {Object.keys(rainResult.spread_summary).length > 0 && (
                  <div className="rain-spread-table">
                    <div className="rain-spread-header">
                      <span>New Date</span>
                      <span>Jobs</span>
                    </div>
                    {Object.entries(rainResult.spread_summary)
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([date, count]) => (
                        <div key={date} className="rain-spread-row">
                          <span>{formatSpreadDate(date)}</span>
                          <span>{count} job{count !== 1 ? "s" : ""}</span>
                        </div>
                      ))}
                  </div>
                )}
              </>
            )}
          </div>
          <div className="cal-modal-footer">
            {rainStep === "select" && (
              <button
                className="cal-modal-btn cal-modal-btn-primary"
                disabled={!rainDate || rainLoading}
                onClick={handleRainPreview}
              >
                {rainLoading ? "Loading..." : "Preview Affected Jobs"}
              </button>
            )}
            {rainStep === "preview" && rainPreview && rainPreview.jobs_count > 0 && (
              <>
                <button
                  className="cal-modal-btn"
                  onClick={() => setRainStep("select")}
                >
                  Back
                </button>
                <button
                  className="cal-modal-btn rain-confirm-btn"
                  onClick={handleRainConfirm}
                >
                  Confirm Reschedule
                </button>
              </>
            )}
            {rainStep === "preview" && rainPreview && rainPreview.jobs_count === 0 && (
              <button className="cal-modal-btn" onClick={() => setRainStep("select")}>
                Back
              </button>
            )}
            {rainStep === "done" && (
              <button className="cal-modal-btn cal-modal-btn-primary" onClick={() => setRainOpen(false)}>
                Done
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Create Job Modal */}
      <div
        className={`cal-modal-backdrop${createOpen ? " open" : ""}`}
        onClick={(e) => {
          if (e.target === e.currentTarget) setCreateOpen(false)
        }}
      >
        <div className="cal-modal" style={{ maxWidth: 900, maxHeight: "calc(100vh - 2rem)" }}>
          <div className="cal-modal-header">
            <h5>{createForm.is_quote ? "Create Quote" : "Create Job"}</h5>
            <button
              className="cal-modal-close"
              onClick={() => { setCreateOpen(false); setQuoteSuccess(null); pmReset() }}
            >
              &times;
            </button>
          </div>
          {quoteSuccess ? (
            <div className="cal-modal-body" style={{ textAlign: "center", padding: "2rem 1.5rem" }}>
              <div style={{ fontSize: "2.5rem", marginBottom: "0.75rem" }}>&#10003;</div>
              <h3 style={{ fontSize: "1.1rem", fontWeight: 600, marginBottom: "0.5rem" }}>
                {quoteSuccess.sent ? "Quote Sent!" : "Quote Created"}
              </h3>
              <p style={{ color: "#a1a1aa", fontSize: "0.85rem", marginBottom: "1.25rem" }}>
                {quoteSuccess.sent
                  ? `${createForm.customer_name || "Customer"} will receive an SMS with their quote link. They can pick their package, add extras, and pay online.`
                  : "Review the quote or text it to the customer when ready."}
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", alignItems: "center" }}>
                <a
                  href={quoteSuccess.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: "inline-block",
                    padding: "0.5rem 1.25rem",
                    background: "#3b82f6",
                    color: "#fff",
                    borderRadius: "0.375rem",
                    textDecoration: "none",
                    fontSize: "0.85rem",
                    fontWeight: 500,
                  }}
                >
                  View Quote
                </a>
                <button
                  className="cal-modal-btn"
                  disabled={quoteSuccess.sent || quoteSuccess.sending}
                  onClick={async () => {
                    if (!quoteSuccess.quoteId) {
                      alert("Quote ID missing — cannot send SMS. Try creating the quote again.")
                      return
                    }
                    setQuoteSuccess(prev => prev ? { ...prev, sending: true } : prev)
                    try {
                      const res = await fetch("/api/actions/quotes/send", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ quote_id: quoteSuccess.quoteId }),
                      })
                      const data = await res.json()
                      if (data.success) {
                        setQuoteSuccess(prev => prev ? { ...prev, sent: true, sending: false } : prev)
                      } else {
                        alert(data.error || "Failed to send SMS")
                        setQuoteSuccess(prev => prev ? { ...prev, sending: false } : prev)
                      }
                    } catch {
                      alert("Failed to send SMS")
                      setQuoteSuccess(prev => prev ? { ...prev, sending: false } : prev)
                    }
                  }}
                  style={{
                    fontSize: "0.85rem",
                    fontWeight: 500,
                    padding: "0.5rem 1.25rem",
                    background: quoteSuccess.sent ? "#22c55e" : "#8b5cf6",
                    color: "#fff",
                    borderRadius: "0.375rem",
                    border: "none",
                    cursor: quoteSuccess.sent ? "default" : "pointer",
                    opacity: quoteSuccess.sending ? 0.7 : 1,
                  }}
                >
                  {quoteSuccess.sending ? "Sending..." : quoteSuccess.sent ? "Sent!" : "Text to Customer"}
                </button>
                {/* Payment menu ($) */}
                <button
                  ref={pmBtnRef}
                  onClick={() => pmToggle()}
                  className={`p-2 rounded-lg transition-colors ${pmOpen ? "text-purple-400 bg-purple-400/10" : "text-zinc-400 hover:text-purple-400 hover:bg-purple-400/10"}`}
                  title="Payment links"
                  style={{ border: "1px solid rgba(63,63,70,0.5)" }}
                >
                  <DollarSign className="w-4 h-4" />
                </button>
                <button
                  className="cal-modal-btn"
                  onClick={() => {
                    navigator.clipboard.writeText(window.location.origin + quoteSuccess.url)
                    alert("Quote link copied!")
                  }}
                  style={{ fontSize: "0.8rem" }}
                >
                  Copy Link
                </button>
                <button
                  className="cal-modal-btn"
                  onClick={() => {
                    setQuoteSuccess(null)
                    setCreateOpen(false)
                    setPhoneLookedUp("")
                    setPhoneSuggestions([])
                    setShowPhoneSuggestions(false)
                    setCustomerSearch("")
                    setCustomerSearchResults([])
                    formSnapshotRef.current = null
                    isPreviewingRef.current = false
                    basePriceSnapshotRef.current = 0
                    setIsPreviewing(false)
                    setLookedUpCustomerId(null)
                    setCustomerMemberships([])
                  }}
                  style={{ fontSize: "0.8rem", marginTop: "0.25rem" }}
                >
                  Done
                </button>
              </div>
            </div>
          ) : (<>
          <div className="cal-modal-body">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
              {/* ── LEFT COLUMN ── */}
              <div>
                {/* Customer search */}
                <div style={{ position: "relative", marginBottom: "0.5rem" }}>
                  <label className="cal-form-label">Search Customers</label>
                  <input
                    type="text"
                    className="cal-form-control"
                    placeholder="Type a customer name, phone number, or email"
                    value={customerSearch}
                    onChange={(e) => {
                      setCustomerSearch(e.target.value)
                      setLookedUpCustomerId(null)
                      lookedUpCustomerIdRef.current = null
                      if (!e.target.value) { setCustomerSearchResults([]); setShowCustomerSearch(false) }
                    }}
                    onFocus={() => { if (customerSearchResults.length > 0) setShowCustomerSearch(true) }}
                    onBlur={() => setTimeout(() => { if (!isPreviewingRef.current) setShowCustomerSearch(false) }, 200)}
                  />
                  {showCustomerSearch && customerSearchResults.length > 0 && (
                    <div style={{
                      position: "absolute",
                      top: "100%",
                      left: 0,
                      right: 0,
                      zIndex: 100,
                      background: "#1e1e21",
                      border: "1px solid rgba(63, 63, 70, 0.6)",
                      borderRadius: 8,
                      marginTop: 2,
                      maxHeight: 220,
                      overflowY: "auto",
                      boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                    }}>
                      {customerSearchResults.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault()
                            selectPhoneCustomer(s)
                            setCustomerSearch([s.first_name, s.last_name].filter(Boolean).join(" "))
                            setShowCustomerSearch(false)
                          }}
                          style={{
                            display: "block",
                            width: "100%",
                            textAlign: "left",
                            padding: "0.5rem 0.75rem",
                            background: "transparent",
                            border: "none",
                            borderBottom: "1px solid rgba(63, 63, 70, 0.3)",
                            color: "#e4e4e7",
                            fontSize: "0.8rem",
                            cursor: "pointer",
                          }}
                          onMouseEnter={() => previewPhoneCustomer(s)}
                          onMouseLeave={() => revertPreview()}
                        >
                          <div style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {[s.first_name, s.last_name].filter(Boolean).join(" ") || "Unknown"}
                          </div>
                          <div style={{ color: "#71717a", fontSize: "0.75rem" }}>
                            {s.phone_number}
                            {s.email && <span style={{ marginLeft: "0.5rem" }}>{s.email}</span>}
                            {s.address && <span style={{ color: "#52525b", marginLeft: "0.5rem" }}>{s.address}</span>}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {/* Row 1: Phone, Service Type */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem", marginBottom: "0.5rem" }}>
                  <div style={{ position: "relative" }}>
                    <label className="cal-form-label">Customer Phone *</label>
                    <input
                      type="tel"
                      className="cal-form-control"
                      placeholder="(555) 123-4567"
                      value={createForm.customer_phone}
                      onChange={(e) => {
                        setCreateForm((prev) => ({ ...prev, customer_phone: e.target.value }))
                        setLookedUpCustomerId(null)
                        lookedUpCustomerIdRef.current = null
                        setShowPhoneSuggestions(true)
                      }}
                      onFocus={() => { if (phoneSuggestions.length > 0) setShowPhoneSuggestions(true) }}
                      onBlur={() => setTimeout(() => { if (!isPreviewingRef.current) setShowPhoneSuggestions(false) }, 200)}
                    />
                    {showPhoneSuggestions && phoneSuggestions.length > 0 && (
                      <div style={{
                        position: "absolute",
                        top: "100%",
                        left: 0,
                        right: 0,
                        zIndex: 100,
                        background: "#1e1e21",
                        border: "1px solid rgba(63, 63, 70, 0.6)",
                        borderRadius: 8,
                        marginTop: 2,
                        maxHeight: 200,
                        overflowY: "auto",
                        boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                      }}>
                        {phoneSuggestions.map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault()
                              selectPhoneCustomer(s)
                            }}
                            style={{
                              display: "block",
                              width: "100%",
                              textAlign: "left",
                              padding: "0.5rem 0.75rem",
                              background: "transparent",
                              border: "none",
                              borderBottom: "1px solid rgba(63, 63, 70, 0.3)",
                              color: "#e4e4e7",
                              fontSize: "0.8rem",
                              cursor: "pointer",
                            }}
                            onMouseEnter={() => previewPhoneCustomer(s)}
                            onMouseLeave={() => revertPreview()}
                          >
                            <div style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{[s.first_name, s.last_name].filter(Boolean).join(" ")}</div>
                            <div style={{ color: "#71717a", fontSize: "0.75rem", wordBreak: "break-word" }}>
                              {s.phone_number}
                              {s.address && <span style={{ color: "#52525b", marginLeft: "0.5rem" }}>{s.address}</span>}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div>
                    <label className="cal-form-label">Service Type</label>
                    {(() => {
                      const hcTypes = ["Standard cleaning", "Deep cleaning", "Move-in/move-out"]
                      const winTypes = jobServiceTypes.length > 0
                        ? jobServiceTypes
                        : ["Window cleaning", "Pressure washing", "Gutter cleaning", "Walkthru"]
                      const knownTypes = isHouseCleaning ? hcTypes : winTypes
                      const defaultType = knownTypes[0] || "Window cleaning"
                      // Case-insensitive match so last-job auto-fill (e.g. "Power Washing") still matches known types
                      const matchedKnown = knownTypes.find((t) => t.toLowerCase() === (createForm.service_type || "").toLowerCase())
                      const isKnown = !!matchedKnown

                      return (
                        <>
                          <select
                            className={`cal-form-control${previewClass("service_type")}`}
                            value={isKnown ? (matchedKnown || createForm.service_type) : "__custom__"}
                            onChange={(e) => {
                              if (e.target.value === "__custom__") {
                                setCreateForm((prev) => ({ ...prev, service_type: "" }))
                              } else {
                                setCreateForm((prev) => ({ ...prev, service_type: e.target.value }))
                              }
                            }}
                            style={!isKnown && createForm.service_type !== "" ? { display: "none" } : undefined}
                          >
                            {knownTypes.map((t) => (
                              <option key={t} value={t}>{t}</option>
                            ))}
                            <option value="__custom__">Other (type your own)</option>
                          </select>
                          {!isKnown && (
                            <div style={{ display: "flex", gap: "0.25rem", marginTop: "0.25rem" }}>
                              <input
                                type="text"
                                className="cal-form-control"
                                placeholder="Type service name..."
                                autoFocus={!isPreviewing}
                                value={createForm.service_type}
                                onChange={(e) =>
                                  setCreateForm((prev) => ({ ...prev, service_type: e.target.value }))
                                }
                                style={{ flex: 1 }}
                              />
                              <button
                                type="button"
                                className="cal-form-control"
                                style={{ width: "auto", padding: "0 0.5rem", cursor: "pointer", color: "#a1a1aa" }}
                                onClick={() => setCreateForm((prev) => ({ ...prev, service_type: defaultType }))}
                                title="Back to list"
                              >
                                &times;
                              </button>
                            </div>
                          )}
                        </>
                      )
                    })()}
                  </div>
                </div>

                {/* Row 2: Customer Name, Email */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem", marginBottom: "0.5rem" }}>
                  <div>
                    <label className="cal-form-label">Customer Name</label>
                    <input
                      type="text"
                      className={`cal-form-control${previewClass("customer_name")}`}
                      placeholder="John Smith"
                      value={createForm.customer_name}
                      onChange={(e) =>
                        setCreateForm((prev) => ({ ...prev, customer_name: e.target.value }))
                      }
                    />
                  </div>
                  <div>
                    <label className="cal-form-label">Email</label>
                    <input
                      type="email"
                      className={`cal-form-control${previewClass("email")}`}
                      placeholder="john@example.com"
                      value={createForm.email}
                      onChange={(e) =>
                        setCreateForm((prev) => ({ ...prev, email: e.target.value }))
                      }
                    />
                  </div>
                </div>

                {/* Row 3: Address */}
                <div style={{ marginBottom: "0.5rem", position: "relative" }}>
                  <label className="cal-form-label">Address</label>
                  <input
                    type="text"
                    className={`cal-form-control${previewClass("address")}`}
                    placeholder="123 Main St, City, State"
                    value={createForm.address}
                    onChange={(e) => {
                      setCreateForm((prev) => ({ ...prev, address: e.target.value }))
                      setShowAddressSuggestions(true)
                    }}
                    onFocus={() => setShowAddressSuggestions(true)}
                    onBlur={() => setTimeout(() => setShowAddressSuggestions(false), 200)}
                  />
                  {showAddressSuggestions && addressSuggestions.length > 0 && (
                    <div style={{
                      position: "absolute",
                      top: "100%",
                      left: 0,
                      right: 0,
                      zIndex: 100,
                      background: "#1e1e21",
                      border: "1px solid rgba(63, 63, 70, 0.6)",
                      borderRadius: 8,
                      marginTop: 2,
                      maxHeight: 200,
                      overflowY: "auto",
                      boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                    }}>
                      {addressSuggestions.map((s) => (
                        <button
                          key={s.place_id}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault()
                            setCreateForm((prev) => ({ ...prev, address: s.description }))
                            setShowAddressSuggestions(false)
                          }}
                          style={{
                            display: "block",
                            width: "100%",
                            textAlign: "left",
                            padding: "0.5rem 0.75rem",
                            background: "transparent",
                            border: "none",
                            borderBottom: "1px solid rgba(63, 63, 70, 0.3)",
                            color: "#e4e4e7",
                            fontSize: "0.8rem",
                            cursor: "pointer",
                          }}
                          onMouseOver={(e) => (e.currentTarget.style.background = "rgba(63, 63, 70, 0.3)")}
                          onMouseOut={(e) => (e.currentTarget.style.background = "transparent")}
                        >
                          {s.description}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Property Details — house cleaning tenants only */}
                {isHouseCleaning && (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.5rem", marginBottom: "0.5rem" }}>
                    <div>
                      <label className="cal-form-label">Bedrooms *</label>
                      <input
                        type="number"
                        className="cal-form-control"
                        placeholder="3"
                        min="0"
                        step="0.5"
                        value={createForm.bedrooms}
                        onChange={(e) =>
                          setCreateForm((prev) => ({ ...prev, bedrooms: e.target.value }))
                        }
                      />
                    </div>
                    <div>
                      <label className="cal-form-label">Bathrooms *</label>
                      <input
                        type="number"
                        className="cal-form-control"
                        placeholder="2"
                        min="0"
                        step="0.5"
                        value={createForm.bathrooms}
                        onChange={(e) =>
                          setCreateForm((prev) => ({ ...prev, bathrooms: e.target.value }))
                        }
                      />
                    </div>
                    <div>
                      <label className="cal-form-label">Sqft</label>
                      <input
                        type="number"
                        className="cal-form-control"
                        placeholder="1500"
                        min="0"
                        value={createForm.sqft}
                        onChange={(e) =>
                          setCreateForm((prev) => ({ ...prev, sqft: e.target.value }))
                        }
                      />
                    </div>
                  </div>
                )}

                {/* Row 4: Assignment + Cleaners & Membership/Frequency */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: "0.5rem", marginBottom: "0.5rem" }}>
                  <div>
                    <label className="cal-form-label">Assignment</label>
                    <select
                      className="cal-form-control"
                      value={createForm.assignment_mode}
                      onChange={(e) => {
                        const val = e.target.value as AssignmentMode
                        setCreateForm((prev) => ({ ...prev, assignment_mode: val, cleaner_ids: [] }))
                      }}
                    >
                      <option value="auto_broadcast">Auto Broadcast</option>
                      <option value="ranked">Ranked Priority</option>
                      <option value="unassigned">Unassigned</option>
                      <option value="specific">Pick Cleaners</option>
                    </select>
                    {createForm.assignment_mode === "specific" && cleanersList.length > 0 && (
                      <div style={{ marginTop: "0.35rem", display: "flex", flexWrap: "wrap", gap: "0.25rem" }}>
                        {cleanersList.map((c) => {
                          const selected = createForm.cleaner_ids.includes(c.id)
                          return (
                            <button
                              key={c.id}
                              type="button"
                              onClick={() => {
                                setCreateForm((prev) => {
                                  const ids = selected
                                    ? prev.cleaner_ids.filter((id) => id !== c.id)
                                    : [...prev.cleaner_ids, c.id]
                                  return { ...prev, cleaner_ids: ids }
                                })
                              }}
                              style={{
                                padding: "0.2rem 0.5rem",
                                borderRadius: 6,
                                fontSize: "0.75rem",
                                border: selected ? "1px solid #22d3ee" : "1px solid #3f3f46",
                                background: selected ? "rgba(34, 211, 238, 0.15)" : "transparent",
                                color: selected ? "#22d3ee" : "#a1a1aa",
                                cursor: "pointer",
                              }}
                            >
                              {selected ? "✓ " : ""}{c.name}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                  <div style={{ width: "70px" }}>
                    <label className="cal-form-label"># Crew</label>
                    <select
                      className="cal-form-control"
                      value={createForm.cleaner_count}
                      onChange={(e) =>
                        setCreateForm((prev) => ({ ...prev, cleaner_count: e.target.value }))
                      }
                    >
                      <option value="1">1</option>
                      <option value="2">2</option>
                      <option value="3">3</option>
                    </select>
                  </div>
                  {isHouseCleaning ? (
                    <div>
                      <label className="cal-form-label">Frequency *</label>
                      <select
                        className="cal-form-control"
                        value={createForm.frequency}
                        onChange={(e) => {
                          const freq = e.target.value
                          setCreateForm((prev) => {
                            // Recalculate price with frequency discount
                            const freqSlugMap: Record<string, string> = { "weekly": "weekly", "bi-weekly": "biweekly", "monthly": "monthly" }
                            const oldSlug = freqSlugMap[prev.frequency] || null
                            const newSlug = freqSlugMap[freq] || null
                            const oldDiscount = oldSlug ? (servicePlans.find(p => p.slug === oldSlug)?.discount_per_visit || 0) : 0
                            const newDiscount = newSlug ? (servicePlans.find(p => p.slug === newSlug)?.discount_per_visit || 0) : 0
                            const currentPrice = Number(prev.price) || 0
                            // Add back old discount, subtract new discount
                            const adjusted = currentPrice > 0 ? Math.max(0, currentPrice + oldDiscount - newDiscount) : 0
                            return { ...prev, frequency: freq, price: adjusted > 0 ? String(adjusted) : prev.price }
                          })
                        }}
                      >
                        <option value="one-time">One-time</option>
                        <option value="weekly">Weekly</option>
                        <option value="bi-weekly">Bi-weekly</option>
                        <option value="monthly">Monthly</option>
                      </select>
                    </div>
                  ) : (
                    <div>
                      <label className="cal-form-label">Membership</label>
                      <select
                        className="cal-form-control"
                        value={createForm.membership_id}
                        onChange={(e) => {
                          const val = e.target.value
                          let discount = 0
                          if (val.startsWith("membership:")) {
                            const mem = customerMemberships.find((m) => m.id === val.replace("membership:", ""))
                            discount = mem?.service_plans?.discount_per_visit || 0
                          } else if (val.startsWith("plan:")) {
                            const plan = servicePlans.find((p) => p.slug === val.replace("plan:", ""))
                            discount = plan?.discount_per_visit || 0
                          }
                          setCreateForm((prev) => {
                            const updated = { ...prev, membership_id: val }
                            const currentBase = basePrice || Number(prev.price) || 0
                            if (discount && currentBase > 0) {
                              updated.price = String(Math.max(0, currentBase - discount))
                            } else if (!val && currentBase > 0) {
                              updated.price = String(currentBase)
                            }
                            return updated
                          })
                        }}
                      >
                        <option value="">No membership</option>
                        {servicePlans.map((plan) => {
                          const existing = customerMemberships.find((m) => m.service_plans?.slug === plan.slug)
                          if (existing) {
                            return (
                              <option key={plan.slug} value={`membership:${existing.id}`}>
                                ✓ {plan.name} — {existing.visits_completed}/{plan.visits_per_year} visits
                                {plan.discount_per_visit ? ` (-$${plan.discount_per_visit})` : ""}
                              </option>
                            )
                          }
                          return (
                            <option key={plan.slug} value={`plan:${plan.slug}`}>
                              {plan.name}
                              {plan.discount_per_visit ? ` (-$${plan.discount_per_visit}/visit)` : ""}
                            </option>
                          )
                        })}
                      </select>
                    </div>
                  )}
                </div>

                {/* Row 5: Lead Source */}
                <div style={{ marginBottom: "0.5rem" }}>
                  <label className="cal-form-label">Lead Source <span style={{ color: "#ef4444" }}>*</span></label>
                  {(() => {
                    const knownSources = KNOWN_LEAD_SOURCES as readonly string[]
                    const isKnown = knownSources.includes(createForm.lead_source) || createForm.lead_source === ""

                    return (
                      <>
                        <select
                          className="cal-form-control"
                          value={isKnown ? createForm.lead_source : "__custom__"}
                          onChange={(e) => {
                            if (e.target.value === "__custom__") {
                              setCreateForm((prev) => ({ ...prev, lead_source: "__custom__" }))
                            } else {
                              setCreateForm((prev) => ({ ...prev, lead_source: e.target.value }))
                            }
                          }}
                          style={!isKnown ? { display: "none" } : undefined}
                        >
                          <option value="">Select source</option>
                          {knownSources.map((s) => (
                            <option key={s} value={s}>{s}</option>
                          ))}
                          <option value="__custom__">Other (type your own)</option>
                        </select>
                        {!isKnown && (
                          <div style={{ display: "flex", gap: "0.25rem" }}>
                            <input
                              type="text"
                              className="cal-form-control"
                              placeholder="Type lead source..."
                              autoFocus
                              value={createForm.lead_source === "__custom__" ? "" : createForm.lead_source}
                              onChange={(e) =>
                                setCreateForm((prev) => ({ ...prev, lead_source: e.target.value }))
                              }
                              style={{ flex: 1 }}
                            />
                            <button
                              type="button"
                              className="cal-form-control"
                              style={{ width: "auto", padding: "0 0.5rem", cursor: "pointer", color: "#a1a1aa" }}
                              onClick={() => setCreateForm((prev) => ({ ...prev, lead_source: "" }))}
                              title="Back to list"
                            >
                              &times;
                            </button>
                          </div>
                        )}
                      </>
                    )
                  })()}
                </div>

                {/* Row 5b: Credited Salesman (optional) */}
                {!isHouseCleaning && (
                  <div style={{ marginBottom: "0.5rem" }}>
                    <label className="cal-form-label">Credited Salesman</label>
                    <select
                      className="cal-form-control"
                      value={createForm.credited_salesman_id}
                      onChange={(e) => setCreateForm((prev) => ({ ...prev, credited_salesman_id: e.target.value }))}
                    >
                      <option value="">None</option>
                      {cleanersList.map((c) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Row 6: Date, Time, Duration */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.5rem", marginBottom: "0.5rem" }}>
                  <div>
                    <label className="cal-form-label">Date *</label>
                    <input
                      type="date"
                      className="cal-form-control"
                      value={createForm.date}
                      onChange={(e) =>
                        setCreateForm((prev) => ({ ...prev, date: e.target.value }))
                      }
                    />
                  </div>
                  <div>
                    <label className="cal-form-label">Start Time</label>
                    <input
                      type="time"
                      className="cal-form-control"
                      value={createForm.time}
                      onChange={(e) =>
                        setCreateForm((prev) => ({ ...prev, time: e.target.value }))
                      }
                    />
                  </div>
                  <div>
                    <label className="cal-form-label">Duration</label>
                    <select
                      className="cal-form-control"
                      value={createForm.duration_minutes}
                      onChange={(e) =>
                        setCreateForm((prev) => ({ ...prev, duration_minutes: e.target.value }))
                      }
                    >
                      <option value="60">1 hour</option>
                      <option value="90">1.5 hours</option>
                      <option value="120">2 hours</option>
                      <option value="150">2.5 hours</option>
                      <option value="180">3 hours</option>
                      <option value="240">4 hours</option>
                      <option value="300">5 hours</option>
                      <option value="360">6 hours</option>
                      <option value="420">7 hours</option>
                      <option value="480">8 hours</option>
                    </select>
                  </div>
                </div>

                {/* Row 6: Notes + Send as Quote */}
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.25rem" }}>
                    <label className="cal-form-label" style={{ margin: 0 }}>Notes</label>
                    <label style={{ display: "flex", alignItems: "center", gap: "0.35rem", cursor: "pointer", fontSize: "0.8rem", color: createForm.is_quote ? "#22d3ee" : "#a1a1aa" }}>
                      <input
                        type="checkbox"
                        checked={createForm.is_quote}
                        onChange={(e) => setCreateForm((prev) => ({ ...prev, is_quote: e.target.checked }))}
                        style={{ accentColor: "#06b6d4" }}
                      />
                      Send as Quote
                    </label>
                  </div>
                  <textarea
                    className="cal-form-control"
                    rows={2}
                    placeholder="Special instructions, access codes, etc."
                    value={createForm.notes}
                    onChange={(e) =>
                      setCreateForm((prev) => ({ ...prev, notes: e.target.value }))
                    }
                  />
                </div>
              </div>

              {/* ── RIGHT COLUMN ── */}
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {/* Window Tier — WinBros window cleaning only */}
                {!isHouseCleaning && (createForm.service_type || "").toLowerCase().includes("window") && (
                  <div>
                    <label className="cal-form-label">Window Tier *</label>
                    <select
                      className="cal-form-control"
                      value={createForm.selected_tier_index}
                      onChange={(e) =>
                        setCreateForm((prev) => ({ ...prev, selected_tier_index: e.target.value }))
                      }
                    >
                      <option value="">Select tier</option>
                      {windowTiers.map((tier, idx) => (
                        <option key={idx} value={String(idx)}>
                          {tier.label} — ${tier.exterior}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Add-ons */}
                {derivedAddonsList.length > 0 && (
                  <div>
                    <label className="cal-form-label">Add-ons</label>
                    <div style={{
                      background: "rgba(39, 39, 42, 0.3)",
                      borderRadius: 8,
                      border: "1px solid rgba(63, 63, 70, 0.4)",
                      padding: "0.5rem",
                      maxHeight: isHouseCleaning ? 300 : 250,
                      overflowY: "auto",
                    }}>
                      {/* Group add-ons by category */}
                      {(() => {
                        const groups = new Map<string, typeof derivedAddonsList>()
                        for (const addon of derivedAddonsList) {
                          const group = (addon as any).group || "Other"
                          if (!groups.has(group)) groups.set(group, [])
                          groups.get(group)!.push(addon)
                        }
                        return [...groups.entries()].map(([groupName, addons]) => (
                          <div key={groupName}>
                            <div style={{
                              fontSize: "0.65rem",
                              fontWeight: 700,
                              textTransform: "uppercase",
                              letterSpacing: "0.05em",
                              color: "#71717a",
                              padding: "0.4rem 0.4rem 0.15rem",
                              borderTop: groupName !== [...groups.keys()][0] ? "1px solid rgba(63,63,70,0.3)" : "none",
                              marginTop: groupName !== [...groups.keys()][0] ? "0.25rem" : 0,
                            }}>
                              {groupName}
                            </div>
                            {addons.map((addon) => {
                              const st = (createForm.service_type || "").toLowerCase()
                              const tierKey = st.includes("deep") ? "deep" : st.includes("move") ? "move" : "standard"
                              const dbIncluded = Array.isArray((addon as any).included_in) && (addon as any).included_in.includes(tierKey)
                              // Code-level fallback: addons included per tier per quote-pricing.ts definitions
                              const TIER_INCLUDES: Record<string, string[]> = {
                                deep: ['inside_fridge', 'inside_oven', 'inside_microwave', 'baseboards', 'ceiling_fans', 'light_fixtures', 'window_sills'],
                                move: ['inside_fridge', 'inside_oven', 'inside_microwave', 'inside_cabinets', 'inside_dishwasher', 'range_hood', 'baseboards', 'ceiling_fans', 'light_fixtures', 'window_sills', 'wall_spot_cleaning', 'grout_scrubbing', 'behind_under_appliances', 'window_tracks', 'baseboards_hand_wipe', 'light_fixtures_detailed'],
                              }
                              const codeIncluded = (TIER_INCLUDES[tierKey] || []).includes(addon.addon_key)
                              const isIncluded = isHouseCleaning && (dbIncluded || codeIncluded)
                              return (
                              <label
                                key={addon.addon_key}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "0.5rem",
                                  cursor: "pointer",
                                  padding: "0.3rem 0.4rem",
                                  borderRadius: 4,
                                  fontSize: "0.8rem",
                                  color: createForm.selected_addons.includes(addon.addon_key) ? "#e4e4e7" : "#a1a1aa",
                                  background: createForm.selected_addons.includes(addon.addon_key) ? "rgba(139, 92, 246, 0.15)" : "transparent",
                                }}
                              >
                                <input
                                  type="checkbox"
                                  checked={createForm.selected_addons.includes(addon.addon_key)}
                                  onChange={(e) => {
                                    setCreateForm((prev) => ({
                                      ...prev,
                                      selected_addons: e.target.checked
                                        ? [...prev.selected_addons, addon.addon_key]
                                        : prev.selected_addons.filter((k) => k !== addon.addon_key),
                                    }))
                                  }}
                                  style={{ accentColor: "#8b5cf6" }}
                                />
                                <span style={{ flex: 1 }}>{addon.label}</span>
                                <span style={{
                                  color: isIncluded ? "#4ade80" : addon.flat_price > 0 ? "#a1a1aa" : "#4ade80",
                                  fontSize: "0.75rem",
                                  fontWeight: 600,
                                }}>
                                  {isIncluded ? "INCLUDED" : addon.flat_price > 0 ? `+$${addon.flat_price}` : "FREE"}
                                </span>
                              </label>
                              )
                            })}
                          </div>
                        ))
                      })()}
                    </div>
                  </div>
                )}

                {/* Price Summary */}
                <div style={{
                  background: "rgba(39, 39, 42, 0.3)",
                  borderRadius: 8,
                  border: "1px solid rgba(63, 63, 70, 0.4)",
                  padding: "0.75rem",
                  height: 150,
                  overflowY: "auto",
                }}>
                  <div style={{ fontSize: "0.75rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "#e4e4e7", marginBottom: "0.5rem" }}>
                    Price Summary
                  </div>
                  {(() => {
                    const tierIdx = createForm.selected_tier_index === "" ? -1 : Number(createForm.selected_tier_index)
                    const tier = tierIdx >= 0 && tierIdx < windowTiers.length ? windowTiers[tierIdx] : null
                    const isWindow = !isHouseCleaning && (createForm.service_type || "").toLowerCase().includes("window")

                    const items: { label: string; price: number }[] = []

                    if (isWindow && tier) {
                      items.push({ label: "Exterior Window Cleaning", price: tier.exterior })
                    } else if (basePrice > 0) {
                      items.push({ label: createForm.service_type || "Base Service", price: basePrice })
                    }

                    // Selected add-ons (skip price for included addons)
                    const st = (createForm.service_type || "").toLowerCase()
                    const summaryTierKey = st.includes("deep") ? "deep" : st.includes("move") ? "move" : "standard"
                    const TIER_INCLUDES_SUMMARY: Record<string, string[]> = {
                      deep: ['inside_fridge', 'inside_oven', 'inside_microwave', 'baseboards', 'ceiling_fans', 'light_fixtures', 'window_sills'],
                      move: ['inside_fridge', 'inside_oven', 'inside_microwave', 'inside_cabinets', 'inside_dishwasher', 'range_hood', 'baseboards', 'ceiling_fans', 'light_fixtures', 'window_sills', 'wall_spot_cleaning', 'grout_scrubbing', 'behind_under_appliances', 'window_tracks', 'baseboards_hand_wipe', 'light_fixtures_detailed'],
                    }
                    for (const key of createForm.selected_addons) {
                      const addon = derivedAddonsList.find((a) => a.addon_key === key)
                      if (addon) {
                        const addonDbIncluded = isHouseCleaning && Array.isArray((addon as any).included_in) && (addon as any).included_in.includes(summaryTierKey)
                        const addonCodeIncluded = isHouseCleaning && (TIER_INCLUDES_SUMMARY[summaryTierKey] || []).includes(key)
                        const addonIncluded = addonDbIncluded || addonCodeIncluded
                        if (addonIncluded) continue // included in tier price, don't add to summary
                        items.push({ label: addon.label, price: addon.flat_price || 0 })
                      }
                    }

                    // Membership / frequency discount
                    let discount = 0
                    let discountLabel = "Membership Discount"
                    if (createForm.membership_id) {
                      if (createForm.membership_id.startsWith("membership:")) {
                        const mem = customerMemberships.find((m) => m.id === createForm.membership_id.replace("membership:", ""))
                        discount = mem?.service_plans?.discount_per_visit || 0
                      } else if (createForm.membership_id.startsWith("plan:")) {
                        const plan = servicePlans.find((p) => p.slug === createForm.membership_id.replace("plan:", ""))
                        discount = plan?.discount_per_visit || 0
                      }
                    }
                    // House cleaning recurring frequency discount
                    if (isHouseCleaning && createForm.frequency && createForm.frequency !== "one-time") {
                      const freqMap: Record<string, { slug: string; label: string }> = {
                        "weekly": { slug: "weekly", label: "Weekly Discount" },
                        "bi-weekly": { slug: "biweekly", label: "Bi-Weekly Discount" },
                        "monthly": { slug: "monthly", label: "Monthly Discount" },
                      }
                      const fm = freqMap[createForm.frequency]
                      if (fm) {
                        const plan = servicePlans.find((p) => p.slug === fm.slug)
                        if (plan) {
                          discount = plan.discount_per_visit || 0
                          discountLabel = fm.label
                        }
                      }
                    }

                    const subtotal = items.reduce((sum, i) => sum + i.price, 0)
                    const total = Math.max(0, subtotal - discount)

                    if (items.length === 0) {
                      return <p style={{ color: "#71717a", fontSize: "0.8rem", fontStyle: "italic", margin: 0 }}>No items yet</p>
                    }

                    return (
                      <div style={{ fontSize: "0.8rem" }}>
                        {items.map((item, i) => (
                          <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "0.2rem 0", color: item.price > 0 ? "#e4e4e7" : "#4ade80" }}>
                            <span>{item.label}</span>
                            <span>{item.price > 0 ? `$${item.price}` : "FREE"}</span>
                          </div>
                        ))}
                        {discount > 0 && (
                          <div style={{ display: "flex", justifyContent: "space-between", padding: "0.2rem 0", color: "#4ade80" }}>
                            <span>{discountLabel}</span>
                            <span>-${discount}</span>
                          </div>
                        )}
                        <div style={{ display: "flex", justifyContent: "space-between", padding: "0.4rem 0 0", marginTop: "0.3rem", borderTop: "1px solid rgba(63, 63, 70, 0.4)", fontWeight: 700, color: "#e4e4e7" }}>
                          <span>Total</span>
                          <span>${total}</span>
                        </div>
                      </div>
                    )
                  })()}
                </div>

                {/* Override Price */}
                <div>
                  <label className="cal-form-label">Override Price</label>
                  <input
                    type="number"
                    className={`cal-form-control${previewClass("price")}`}
                    placeholder="0.00"
                    min="0"
                    step="0.01"
                    value={createForm.price}
                    onChange={(e) =>
                      setCreateForm((prev) => ({ ...prev, price: e.target.value }))
                    }
                    onBlur={(e) => {
                      if (!isHouseCleaning) {
                        const total = Number(e.target.value) || 0
                        const addonTotal = createForm.selected_addons.reduce((sum, key) => {
                          const addon = derivedAddonsList.find((a) => a.addon_key === key)
                          return sum + (addon?.flat_price || 0)
                        }, 0)
                        setBasePrice(Math.max(0, total - addonTotal))
                      }
                    }}
                  />
                </div>
              </div>
            </div>

            {createError && (
              <p style={{ color: "#f87171", fontSize: "0.8rem", marginTop: "0.5rem" }}>{createError}</p>
            )}
          </div>
          <div className="cal-modal-footer">
            <button
              className="cal-modal-btn"
              onClick={() => setCreateOpen(false)}
              disabled={createSaving}
            >
              Cancel
            </button>
            <button
              className="cal-modal-btn cal-modal-btn-primary"
              onClick={handleCreateSave}
              disabled={createSaving}
            >
              {createSaving ? <><span className="saving-spinner" /> Creating...</> : createForm.is_quote ? "Create Quote" : "Create Job"}
            </button>
          </div>
          </>)}
        </div>
      </div>
      {pmOpen && renderPaymentMenu(!!selectedEvent?.cardOnFile)}

      {/* Standalone Enter Card modal — rendered at top level, no stacking context issues */}
      {cardFormOpen && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 10000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.6)" }}
          onClick={(e) => { if (e.target === e.currentTarget) setCardFormOpen(false) }}
        >
          <div style={{ width: "100%", maxWidth: 360, borderRadius: 12, background: "#18181b", border: "1px solid rgba(255,255,255,0.08)", boxShadow: "0 20px 50px rgba(0,0,0,0.5)" }}>
            <StripeCardForm
              customerId={pmGetCustomerId() || ""}
              onSuccess={() => setCardFormOpen(false)}
              onCancel={() => setCardFormOpen(false)}
            />
          </div>
        </div>
      )}

      {/* Job Detail Drawer — full execution flow slides in from right */}
      <JobDetailDrawer
        jobId={drawerJobId}
        open={drawerJobId !== null}
        onClose={() => setDrawerJobId(null)}
        onJobUpdated={refreshJobs}
      />

      {/* Quote Builder Sheet — popup on this URL (no navigation away) */}
      <QuoteBuilderSheet
        quoteId={quoteSheetId}
        open={quoteSheetId !== null}
        onClose={() => setQuoteSheetId(null)}
        onSaved={refreshJobs}
      />
    </>
  )
}
