"use client"

import { useEffect, useMemo, useState } from "react"
import CubeLoader from "@/components/ui/cube-loader"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Funnel,
  FunnelChart,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import {
  Phone,
  MessageSquare,
  Globe,
  Instagram,
  Search,
  Filter,
  ArrowUpRight,
  ArrowDownRight,
  TrendingUp,
  X,
  ThumbsUp,
  MapPin,
  Radar,
  Building,
  Star,
  Wrench,
  RefreshCw,
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { ApiResponse, Lead as ApiLead, PaginatedResponse } from "@/lib/types"

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return "—"
  const diffMs = Date.now() - t
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

const sourceLabels: Record<string, string> = {
  phone: "Phone Call",
  meta: "Meta Ads",
  website: "Website",
  sms: "SMS",
  sam: "SAM",
  google_lsa: "Google LSA",
  google: "Google Ads",
  ghl: "GoHighLevel",
  thumbtack: "Thumbtack",
  angi: "Angi",
  housecall_pro: "HouseCall Pro",
  manual: "Manual",
  email: "Email",
  vapi: "VAPI Call",
  retargeting: "Retargeting",
}

function titleSource(source: string): string {
  if (!source) return "Other"
  return sourceLabels[source] || source.slice(0, 1).toUpperCase() + source.slice(1)
}

type UiLead = {
  id: string
  name: string
  phone: string
  source: "phone" | "meta" | "website" | "sms" | "thumbtack" | "google" | "sam" | "google_lsa" | "ghl" | "angi" | "retargeting"
  status: "new" | "contacted" | "qualified" | "booked" | "nurturing" | "lost"
  service: string
  estimatedValue: number
  createdAt: string
  isSam: boolean
}

function mapLead(l: ApiLead): UiLead {
  const knownSources: UiLead["source"][] = ["meta", "website", "sms", "thumbtack", "google", "sam", "google_lsa", "ghl", "angi", "retargeting"]
  const source = (knownSources.includes(l.source as any) ? l.source : "phone") as UiLead["source"]
  const isSam = l.source === "sam" || (l as any).form_data?.sam_handoff === true
  const status =
    (l.status === "new" ||
    l.status === "contacted" ||
    l.status === "qualified" ||
    l.status === "booked" ||
    l.status === "nurturing" ||
    l.status === "lost"
      ? l.status
      : "new") as UiLead["status"]

  return {
    id: String(l.id),
    name: l.name || "Unknown",
    phone: l.phone || "",
    source,
    status,
    service: l.service_interest || "Service inquiry",
    estimatedValue: l.estimated_value != null ? Number(l.estimated_value) : 0,
    createdAt: timeAgo(l.created_at),
    isSam,
  }
}

const sourceIcons = {
  phone: Phone,
  meta: Instagram,
  website: Globe,
  sms: MessageSquare,
  thumbtack: Wrench,
  google: MapPin,
  sam: Radar,
  google_lsa: MapPin,
  ghl: Building,
  angi: Star,
  retargeting: RefreshCw,
}

const sourceColors: Record<string, string> = {
  phone: "bg-primary/15 text-primary",
  meta: "bg-pink-500/15 text-pink-500",
  website: "bg-emerald-500/15 text-emerald-400",
  sms: "bg-accent/15 text-accent",
  sam: "bg-orange-500/15 text-orange-500",
  google_lsa: "bg-green-500/15 text-green-400",
  google: "bg-blue-500/15 text-blue-400",
  ghl: "bg-purple-500/15 text-purple-400",
  thumbtack: "bg-yellow-500/15 text-yellow-400",
  angi: "bg-red-500/15 text-red-400",
  retargeting: "bg-cyan-500/15 text-cyan-400",
}

const statusConfig = {
  new: { label: "New", className: "bg-primary/10 text-primary border-primary/20" },
  contacted: { label: "Contacted", className: "bg-warning/10 text-warning border-warning/20" },
  qualified: { label: "Qualified", className: "bg-accent/10 text-accent border-accent/20" },
  booked: { label: "Booked", className: "bg-success/10 text-success border-success/20" },
  nurturing: { label: "Nurturing", className: "bg-muted text-muted-foreground border-border" },
  lost: { label: "Lost", className: "bg-destructive/10 text-destructive border-destructive/20" },
}

const chartConfig = {
  leads: { label: "Leads", color: "#5b8def" },
  booked: { label: "Booked", color: "#4ade80" },
}

export default function LeadsPage() {
  const [leads, setLeads] = useState<UiLead[]>([])
  const [rawLeads, setRawLeads] = useState<ApiLead[]>([])
  const [loading, setLoading] = useState(false)
  const [statusFilter, setStatusFilter] = useState<string>("all")
  const [sourceFilter, setSourceFilter] = useState<string>("all")
  const [selectedLead, setSelectedLead] = useState<ApiLead | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const res = await fetch(`/api/leads?page=1&per_page=200`, { cache: "no-store" })
        const json = (await res.json()) as PaginatedResponse<ApiLead> | ApiResponse<any>
        const raw = (json as any)?.data
        const rows = Array.isArray(raw) ? raw : (json as PaginatedResponse<ApiLead>).data
        const mapped = (rows || []).map(mapLead)
        if (!cancelled) {
          setLeads(mapped)
          setRawLeads(rows || [])
        }
      } catch {
        if (!cancelled) setLeads([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  const filteredLeads = useMemo(() => {
    let result = leads
    if (statusFilter !== "all") result = result.filter((l) => l.status === statusFilter)
    if (sourceFilter !== "all") {
      if (sourceFilter === "sam") {
        result = result.filter((l) => l.isSam)
      } else {
        result = result.filter((l) => l.source === sourceFilter)
      }
    }
    return result
  }, [leads, statusFilter, sourceFilter])

  const funnel = useMemo(() => {
    const total = leads.length
    const contacted = leads.filter((l) => ["contacted", "qualified", "booked", "nurturing"].includes(l.status)).length
    const qualified = leads.filter((l) => ["qualified", "booked"].includes(l.status)).length
    const booked = leads.filter((l) => l.status === "booked").length
    return [
      { name: "Leads In", value: total, fill: "#5b8def" },
      { name: "Contacted", value: contacted, fill: "#38bdf8" },
      { name: "Qualified", value: qualified, fill: "#2dd4bf" },
      { name: "Booked", value: booked, fill: "#4ade80" },
    ]
  }, [leads])

  const sourceData = useMemo(() => {
    const sources: Array<UiLead["source"]> = ["phone", "meta", "website", "sms", "sam", "google_lsa", "thumbtack", "ghl"]
    return sources.map((s) => {
      const items = leads.filter((l) => l.source === s)
      const booked = items.filter((l) => l.status === "booked").length
      const rate = items.length ? Math.round((booked / items.length) * 100) : 0
      return { source: titleSource(s), leads: items.length, booked, rate }
    })
  }, [leads])

  const totals = useMemo(() => {
    const total = leads.length
    const booked = leads.filter((l) => l.status === "booked").length
    const avgValue =
      leads.length ? Math.round(leads.reduce((sum, l) => sum + Number(l.estimatedValue || 0), 0) / leads.length) : 0
    const closeRate = total ? Math.round((booked / total) * 100) : 0
    return { total, booked, avgValue, closeRate }
  }, [leads])

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Lead Funnel</h1>
          <p className="text-sm text-muted-foreground">Track leads from intake to booking</p>
        </div>
        <Select defaultValue="week">
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="today">Today</SelectItem>
            <SelectItem value="week">This Week</SelectItem>
            <SelectItem value="month">This Month</SelectItem>
            <SelectItem value="quarter">This Quarter</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Stats Row */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Total Leads</p>
                <p className="text-3xl font-semibold text-foreground">{totals.total}</p>
              </div>
              <div className="flex items-center text-success">
                <ArrowUpRight className="h-4 w-4" />
                <span className="text-sm font-medium">—</span>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Booked</p>
                <p className="text-3xl font-semibold text-foreground">{totals.booked}</p>
              </div>
              <div className="flex items-center text-success">
                <ArrowUpRight className="h-4 w-4" />
                <span className="text-sm font-medium">—</span>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Close Rate</p>
                <p className="text-3xl font-semibold text-foreground">{totals.closeRate}%</p>
              </div>
              <div className="flex items-center text-destructive">
                <ArrowDownRight className="h-4 w-4" />
                <span className="text-sm font-medium">—</span>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Avg Lead Value</p>
                <p className="text-3xl font-semibold text-foreground">${totals.avgValue}</p>
              </div>
              <div className="flex items-center text-success">
                <ArrowUpRight className="h-4 w-4" />
                <span className="text-sm font-medium">—</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Charts */}
      <div className="grid gap-4 md:gap-6 md:grid-cols-2">
        {/* Funnel Chart */}
        <Card>
          <CardHeader>
            <CardTitle>Conversion Funnel</CardTitle>
            <CardDescription>Lead progression through stages</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {funnel.map((stage, index) => {
                const base = funnel[0]?.value || 0
                const percentage = base ? Math.round((stage.value / base) * 100) : 0
                const dropoff = index > 0 ? funnel[index - 1].value - stage.value : 0
                
                return (
                  <div key={stage.name} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-foreground">{stage.name}</span>
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-muted-foreground">{stage.value}</span>
                        {index > 0 && (
                          <span className="text-xs text-destructive">(-{dropoff})</span>
                        )}
                      </div>
                    </div>
                    <div className="relative h-8 overflow-hidden rounded-lg bg-muted">
                      <div
                        className="absolute inset-y-0 left-0 rounded-lg transition-all duration-500"
                        style={{ width: `${percentage}%`, backgroundColor: stage.fill }}
                      />
                      <span className="absolute inset-0 flex items-center justify-center text-xs font-medium text-foreground">
                        {percentage}%
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>

        {/* Source Performance */}
        <Card>
          <CardHeader>
            <CardTitle>Source Performance</CardTitle>
            <CardDescription>Leads and conversions by source</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={chartConfig} className="h-[280px] w-full">
              <BarChart data={sourceData} layout="vertical" margin={{ left: 0, right: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#374151" horizontal={false} />
                <XAxis type="number" tick={{ fill: "#9ca3af", fontSize: 12 }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="source" tick={{ fill: "#9ca3af", fontSize: 12 }} axisLine={false} tickLine={false} width={60} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="leads" fill="#5b8def" radius={[0, 4, 4, 0]} />
                <Bar dataKey="booked" fill="#4ade80" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ChartContainer>

            {/* Conversion rates */}
            <div className="mt-4 grid grid-cols-4 gap-2">
              {sourceData.map((source) => (
                <div key={source.source} className="text-center">
                  <p className="text-xs text-muted-foreground">{source.source}</p>
                  <p className="text-sm font-semibold text-foreground">{source.rate}%</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Leads Table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>All Leads</CardTitle>
            <CardDescription>Complete lead pipeline</CardDescription>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input placeholder="Search leads..." className="w-full sm:w-64 pl-10" />
            </div>
            <Select value={sourceFilter} onValueChange={setSourceFilter}>
              <SelectTrigger className="w-32">
                <Radar className="mr-2 h-4 w-4" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Sources</SelectItem>
                <SelectItem value="phone">Phone Call</SelectItem>
                <SelectItem value="meta">Meta Ads</SelectItem>
                <SelectItem value="google_lsa">Google LSA</SelectItem>
                <SelectItem value="google">Google Ads</SelectItem>
                <SelectItem value="website">Website</SelectItem>
                <SelectItem value="sms">SMS</SelectItem>
                <SelectItem value="sam">SAM</SelectItem>
                <SelectItem value="ghl">GoHighLevel</SelectItem>
                <SelectItem value="thumbtack">Thumbtack</SelectItem>
                <SelectItem value="angi">Angi</SelectItem>
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-32">
                <Filter className="mr-2 h-4 w-4" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="new">New</SelectItem>
                <SelectItem value="contacted">Contacted</SelectItem>
                <SelectItem value="qualified">Qualified</SelectItem>
                <SelectItem value="booked">Booked</SelectItem>
                <SelectItem value="lost">Lost</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {filteredLeads.map((lead) => {
              const SourceIcon = sourceIcons[lead.source as keyof typeof sourceIcons]
              return (
                <div
                  key={lead.id}
                  className="flex items-center gap-4 rounded-lg border border-border bg-muted/30 p-4 transition-colors hover:bg-muted/50"
                >
                  <div
                    className={cn(
                      "flex h-10 w-10 shrink-0 items-center justify-center rounded-full",
                      lead.source === "phone" && "bg-primary/10",
                      lead.source === "meta" && "bg-pink-500/10",
                      lead.source === "website" && "bg-success/10",
                      lead.source === "sms" && "bg-accent/10",
                      lead.source === "sam" && "bg-orange-500/10"
                    )}
                  >
                    <SourceIcon
                      className={cn(
                        "h-5 w-5",
                        lead.source === "phone" && "text-primary",
                        lead.source === "meta" && "text-pink-500",
                        lead.source === "website" && "text-success",
                        lead.source === "sms" && "text-accent",
                        lead.source === "sam" && "text-orange-500"
                      )}
                    />
                  </div>

                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">{lead.name}</span>
                      <Badge
                        variant="outline"
                        className={statusConfig[lead.status as keyof typeof statusConfig].className}
                      >
                        {statusConfig[lead.status as keyof typeof statusConfig].label}
                      </Badge>
                      {lead.isSam && (
                        <Badge variant="outline" className="bg-orange-500/10 text-orange-500 border-orange-500/20 text-[10px]">
                          SAM
                        </Badge>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground">{lead.service}</p>
                  </div>

                  <div className="text-right">
                    <p className="font-medium text-foreground">${lead.estimatedValue}</p>
                    <p className="text-xs text-muted-foreground">{lead.createdAt}</p>
                  </div>

                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const rawLead = rawLeads.find((r) => String(r.id) === lead.id)
                      if (rawLead) {
                        setSelectedLead(rawLead)
                        setDialogOpen(true)
                      }
                    }}
                  >
                    View
                  </Button>
                </div>
              )
            })}
            {loading && <CubeLoader />}
            {!loading && leads.length === 0 && (
              <p className="text-sm text-muted-foreground">No leads yet.</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Lead Detail Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="w-[calc(100%-2rem)] max-w-lg mx-auto">
          <DialogHeader>
            <DialogTitle>Lead Details</DialogTitle>
            <DialogDescription>
              {selectedLead?.name || "Unknown"} - {selectedLead?.phone || "No phone"}
            </DialogDescription>
          </DialogHeader>
          {selectedLead && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground">Status</p>
                  <Badge
                    variant="outline"
                    className={statusConfig[selectedLead.status as keyof typeof statusConfig]?.className || ""}
                  >
                    {statusConfig[selectedLead.status as keyof typeof statusConfig]?.label || selectedLead.status}
                  </Badge>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Source</p>
                  {(() => {
                    const src = selectedLead.source || "phone"
                    const SourceIcon = sourceIcons[src as keyof typeof sourceIcons] || Phone
                    const colorClass = sourceColors[src] || "bg-muted text-muted-foreground"
                    return (
                      <div className="flex items-center gap-2">
                        <div className={cn("flex h-6 w-6 items-center justify-center rounded-full", colorClass)}>
                          <SourceIcon className="h-3.5 w-3.5" />
                        </div>
                        <p className="font-medium">{titleSource(src)}</p>
                      </div>
                    )
                  })()}
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Phone</p>
                  <p className="font-medium">{selectedLead.phone || "—"}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Email</p>
                  <p className="font-medium">{selectedLead.email || "—"}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Service Interest</p>
                  <p className="font-medium">{selectedLead.service_interest || "—"}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Estimated Value</p>
                  <p className="font-medium">${selectedLead.estimated_value || 0}</p>
                </div>
              </div>
              {(selectedLead as any).form_data?.sam_handoff && (
                <div className="rounded-lg border border-orange-500/20 bg-orange-500/5 p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <Radar className="h-4 w-4 text-orange-500" />
                    <p className="text-sm font-medium text-orange-500">SAM Prospect Data</p>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <p className="text-muted-foreground text-xs">SAM Score</p>
                      <p className="font-medium">{(selectedLead as any).form_data.sam_score || 0}/100</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground text-xs">Vertical</p>
                      <p className="font-medium capitalize">{((selectedLead as any).form_data.sam_vertical || "unknown").replace(/_/g, " ")}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground text-xs">Lead Type</p>
                      <p className="font-medium capitalize">{((selectedLead as any).form_data.sam_lead_type || "unknown").replace(/_/g, " ")}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground text-xs">Emails Sent</p>
                      <p className="font-medium">{(selectedLead as any).form_data.sam_outreach_count || 0}</p>
                    </div>
                    {(selectedLead as any).form_data.company_name && (
                      <div className="col-span-2">
                        <p className="text-muted-foreground text-xs">Company</p>
                        <p className="font-medium">{(selectedLead as any).form_data.company_name}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}
              {(selectedLead as any).form_data && !(selectedLead as any).form_data.sam_handoff && (
                <div>
                  <p className="text-sm text-muted-foreground mb-2">Additional Details</p>
                  <pre className="text-xs bg-muted p-3 rounded-lg overflow-auto max-h-48">
                    {JSON.stringify((selectedLead as any).form_data, null, 2)}
                  </pre>
                </div>
              )}
              <div className="flex gap-2 pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.open(`tel:${selectedLead.phone}`, "_self")}
                  disabled={!selectedLead.phone}
                >
                  <Phone className="h-4 w-4 mr-2" />
                  Call
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.open(`sms:${selectedLead.phone}`, "_self")}
                  disabled={!selectedLead.phone}
                >
                  <MessageSquare className="h-4 w-4 mr-2" />
                  Text
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
