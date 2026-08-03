import type { Coordinate } from '../coords.ts';
import type { EstimatorPolicy } from './config.ts';

export type BuildingType = 'apartment' | 'midrise' | 'highrise';
export type FloorGroup = 'first' | 'low' | 'middle' | 'top' | 'high';
export type LocationMethod = 'exact-doorplate' | 'address-range' | 'nearest-doorplate' | 'unresolved';
export type EstimateStatus = 'reliable' | 'review' | 'unavailable';
export type EstimateConfidence = 'high' | 'medium' | 'low';
export type TransactionEligibility = 'reliable-eligible' | 'review-only';
export type NormalizedPrimaryUse =
  | 'residential'
  | 'mixed-residential'
  | 'office'
  | 'commercial'
  | 'industrial'
  | 'mixed-industrial'
  | 'unknown';
export type ParkingFamily = 'flat' | 'mechanical' | 'none' | 'unknown';
export type ParkingGrade = 'A' | 'B' | 'C';
export type SubjectOwnershipEvidence =
  | 'profile-default-freehold'
  | 'title-explicit-non-freehold'
  | 'unspecified';

export interface LocationEvidence {
  method: LocationMethod;
  coordinate: Coordinate | null;
  normalizedAddress: string;
  matchedAddress: string | null;
  uncertaintyMeters: number | null;
  confidence: EstimateConfidence;
  datasetVersion: string;
}

export interface SubjectLocationEvidence {
  verdict: 'matched' | 'uncertain' | 'conflict';
  address: LocationEvidence;
  nearestDoorplate: LocationEvidence;
  addressDistanceMeters: number | null;
  /** Distance outside the forward address's uncertainty radius. */
  distanceBeyondUncertaintyMeters: number | null;
  thresholdMeters: number;
  reasons: string[];
}

export interface WeightBreakdown {
  distance: number;
  time: number;
  locationPrecision: number;
  area: number;
  buildingAge: number;
  floor: number;
  total: number;
}

export interface ParkingImputationEvidence {
  asOf: string;
  stage: 'same-building' | 'nearby-500m';
  comparableIds: string[];
  comparableCount: number;
  priceP25Ntd: number;
  priceP50Ntd: number;
  priceP75Ntd: number;
  areaP25Ping: number;
  areaP50Ping: number;
  areaP75Ping: number;
}

export interface ParkingEvidence {
  grade: ParkingGrade;
  family: ParkingFamily;
  originalType: string;
  officialPriceNtd: number | null;
  officialAreaPing: number | null;
  imputation: ParkingImputationEvidence | null;
  reasons: string[];
}

export interface RawParkingEvidence {
  originalType: string;
  areaSqM: number | null;
  priceNtd: number | null;
  areaWasZeroOrEmpty: boolean;
  priceWasZeroOrEmpty: boolean;
  totalAreaSqM: number;
  totalPriceNtd: number;
}

export interface BundleValueQuantiles {
  p25Ntd: number;
  p50Ntd: number;
  p75Ntd: number;
  observationCount: number;
}

export interface MarketTransaction {
  id: string;
  transactionDate: string;
  sourceVersion: string;
  originalAddress: string;
  location: LocationEvidence;
  district: string;
  ownership: 'freehold' | 'non-freehold' | 'unknown';
  buildingType: BuildingType;
  totalPriceNtd: number;
  totalAreaPing: number;
  buildingPriceNtd: number | null;
  buildingAreaPing: number | null;
  parkingPriceNtd: number | null;
  parkingAreaPing: number | null;
  buildingUnitPriceWan: number | null;
  parkingEvidence: ParkingEvidence;
  floor: number;
  totalFloors: number;
  floorGroup: FloorGroup;
  completionDate: string | null;
  notes: string;
  exclusionFlags: string[];
  eligibility: TransactionEligibility;
  eligibilityReasons: string[];
  originalPrimaryUse: string;
  primaryUse: NormalizedPrimaryUse;
  transferredBuildingCount: number | null;
}

export interface TransactionEligibilityEvidence {
  eligibility: TransactionEligibility;
  reasons: string[];
  primaryUse: NormalizedPrimaryUse;
  transferredBuildingCount: number | null;
}

export interface MarketSubject {
  listingId: number | null;
  coordinate: Coordinate;
  district: string;
  ownership: 'freehold' | 'non-freehold' | 'unknown';
  /** Why the listing ownership class was selected for this estimate. */
  ownershipEvidence?: SubjectOwnershipEvidence;
  buildingType: BuildingType;
  buildingAreaPing: number;
  /** Null only for offline held-out evaluation, where the outcome must stay hidden from the estimator. */
  askingUnitPriceWan: number | null;
  floor: number;
  totalFloors: number;
  floorGroup: FloorGroup;
  ageYears: number | null;
  parkingSeparable: boolean;
}

export interface ComparableEvidence {
  transaction: MarketTransaction;
  distanceMinM: number;
  distanceMaxM: number;
  transactionAgeMonths: number;
  weight: WeightBreakdown;
  included: boolean;
  reasons: string[];
}

export interface SourceFreshness {
  transactionCheckedAt: string | null;
  doorplateCheckedAt: string | null;
  transactionStale: boolean;
  doorplateStale: boolean;
}

export interface MarketEstimate {
  status: EstimateStatus;
  confidence: EstimateConfidence;
  /** Retains the listing-side ownership classification and any profile assumption. */
  subjectOwnershipEvidence: SubjectOwnershipEvidence;
  /** Auditable local doorplate check of listing GPS against listing address text. */
  subjectLocationEvidence: SubjectLocationEvidence | null;
  marketUnitPriceMedian: number | null;
  marketUnitPriceP25: number | null;
  marketUnitPriceP75: number | null;
  askingPremiumMedian: number | null;
  askingPremiumConservative: number | null;
  selectedStage: number | null;
  sourceFreshness: SourceFreshness;
  unavailableReasons: string[];
  comparables: ComparableEvidence[];
  excludedCandidates: ComparableEvidence[];
}

export interface DoorplatePoint {
  canonicalAddress: string;
  coordinate: Coordinate;
  district: string;
  roadKey: string;
  mainNumber: number;
  subNumber: number | null;
}

export interface DoorplateIndex {
  schemaVersion: number;
  datasetVersion: string;
  byCanonicalAddress: Record<string, DoorplatePoint[]>;
  byRoad: Record<string, DoorplatePoint[]>;
  cells: Record<string, DoorplatePoint[]>;
}

export interface TransactionIndex {
  schemaVersion: number;
  datasetVersion: string;
  builtAt: string;
  cells: Record<string, MarketTransaction[]>;
}

export interface TransactionBuildDiagnostics {
  rawRows: number;
  reliableEligible: number;
  reviewOnly: number;
  excluded: number;
  excludedByReason: Record<string, number>;
}

export interface SelectionResult {
  selectedStage: number | null;
  included: ComparableEvidence[];
  reviewOnly: ComparableEvidence[];
  excluded: ComparableEvidence[];
  candidates: ComparableEvidence[];
}

export interface MarketDataManifest {
  schemaVersion: number;
  /** Normalization/eligibility semantics used to build the persisted indexes. */
  estimatorPolicyVersion: number;
  buildId: string;
  builtAt: string;
  doorplates: {
    sourceUrl: string;
    publishedAt: string | null;
    checkedAt: string;
    sha256: string;
    recordCount: number;
    etag?: string | null;
    lastModified?: string | null;
  };
  transactions: {
    sourceUrls: string[];
    publishedAt: string | null;
    checkedAt: string;
    sha256: string;
    recordCount: number;
    normalization: TransactionBuildDiagnostics;
  };
  lastFailure: { at: string; reason: string } | null;
  /** Checksums cover every raw and derived file in a published build. */
  artifacts: Record<string, { sha256: string; bytes: number }>;
  /** Per-quarter validators permit immutable historic source reuse. */
  transactionSources?: Record<string, {
    url: string;
    sha256: string;
    etag: string | null;
    lastModified: string | null;
  }>;
}

/** Aggregate-only proof that one exact transaction index passed the quality gate. */
export interface BacktestAcceptance {
  schemaVersion: 2;
  estimatorPolicyVersion: number;
  policyId: EstimatorPolicy['id'];
  transactionArtifactSha256: string;
  approvedAt: string;
  asOf: string;
  evaluatedThrough: string;
  latestEligibleTransactionDate: string;
  thresholds: {
    medianApeMax: number;
    p75ApeMax: number;
    minimumEstimateCoverage: number;
    minimumConfidenceSliceCases: number;
    minimumHighConfidenceImprovement: number;
  };
  metrics: {
    estimateCoverage: number;
    reliableEstimatedCount: number;
    reliableMedianApe: number;
    reliableP75Ape: number;
    highConfidenceEstimatedCount: number;
    highConfidenceMedianApe: number;
    mediumConfidenceEstimatedCount: number;
    mediumConfidenceMedianApe: number;
  };
}

export interface MarketDataBundle {
  manifest: MarketDataManifest;
  doorplates: DoorplateIndex;
  transactions: TransactionIndex;
  /** Present only when a passing artifact matches transactions-index.json exactly. */
  backtestAcceptance?: BacktestAcceptance;
  refresh?: {
    status: 'updated' | 'not-modified' | 'last-known-good';
    failure?: string;
  };
}

export interface SourceDescriptor {
  sourceUrl: string;
  publishedAt: string | null;
  checkedAt: string;
  sha256: string;
  recordCount: number;
}

export interface BuildSummary {
  buildId: string;
  builtAt: string;
  doorplateRecordCount: number;
  transactionRecordCount: number;
  warnings: string[];
}
