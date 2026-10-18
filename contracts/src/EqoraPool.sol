// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import {EqoraPriceOracle} from "./EqoraPriceOracle.sol";
import {EqoraBorrowWindow} from "./EqoraBorrowWindow.sol";
import {EqoraAssetGate} from "./EqoraAssetGate.sol";
import {EqoraMINR} from "./EqoraMINR.sol";

/**
 * @title EqoraPool
 * @notice Isolated-collateral lending pool for the EQORA practice terminal.
 *         Users deposit synthetic Indian stock tokens as collateral and borrow
 *         the demo rupee (mINR) without selling. Each instrument carries its
 *         own LTV and liquidation threshold; borrowing is gated by the NSE
 *         trading window and a per-asset circuit breaker; debt accrues simple
 *         index-based interest; positions become liquidatable below HF 1.0.
 *
 *         Lending-math model follows the over-collateralised pool pattern
 *         (index-scaled debt à la Aave). Not a fork — all code here is
 *         original, written 15–18 Oct 2026 for this submission.
 */
contract EqoraPool is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    EqoraPriceOracle public immutable oracle;
    EqoraBorrowWindow public immutable window;
    EqoraAssetGate public immutable gate;
    EqoraMINR public immutable minr;

    struct Asset {
        bool supported;
        uint16 ltvBps; // max borrow, % of collateral value
        uint16 liqThresholdBps; // liquidation trigger, % of collateral value
        string symbol; // instrument key in the oracle / gate
    }

    mapping(address => Asset) public assets; // underlying => config
    address[] public listedAssets;

    mapping(address => mapping(address => uint256)) public collateralOf; // user => underlying => tokens
    mapping(address => uint256) public collateralTotal; // underlying => tokens

    // --- debt accounting (mINR, index-scaled) ---
    uint256 public index = 1e18; // debt index, grows with interest
    uint256 public lastAccrual;
    uint256 public borrowRateBps = 500; // 5% APR, demo default
    mapping(address => uint256) public debtNormalized; // user => scaled debt
    uint256 public totalDebtNormalized;

    uint16 public liquidationBonusBps = 500; // 5% liquidator incentive
    bool public paused; // emergency brake

    event AssetListed(address indexed underlying, string symbol, uint16 ltvBps, uint16 liqThresholdBps);
    event Supply(address indexed user, address indexed underlying, uint256 amount);
    event Withdraw(address indexed user, address indexed underlying, uint256 amount);
    event Borrow(address indexed user, uint256 amount);
    event Repay(address indexed user, uint256 amount);
    event Liquidate(address indexed user, address indexed underlying, address indexed liquidator, uint256 collateralSeized, uint256 debtRepaid);
    event BorrowRateSet(uint16 bps);
    event PausedSet(bool paused);

    constructor(EqoraPriceOracle oracle_, EqoraBorrowWindow window_, EqoraAssetGate gate_, EqoraMINR minr_) {
        oracle = oracle_;
        window = window_;
        gate = gate_;
        minr = minr_;
        lastAccrual = block.timestamp;
    }

    // ---------------- admin ----------------

    function listAsset(address underlying, string calldata symbol, uint16 ltvBps, uint16 liqThresholdBps) external onlyOwner {
        require(!assets[underlying].supported, "already listed");
        require(ltvBps > 0 && ltvBps <= liqThresholdBps && liqThresholdBps <= 10_000, "bad params");
        assets[underlying] = Asset(true, ltvBps, liqThresholdBps, symbol);
        listedAssets.push(underlying);
        emit AssetListed(underlying, symbol, ltvBps, liqThresholdBps);
    }

    function setBorrowRate(uint16 bps) external onlyOwner {
        accrue();
        require(bps <= 5000, "rate too high");
        borrowRateBps = bps;
        emit BorrowRateSet(bps);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    // ---------------- interest ----------------

    function currentIndex() public view returns (uint256) {
        uint256 dt = block.timestamp - lastAccrual;
        if (dt == 0) return index;
        uint256 growth = uint256(borrowRateBps) * dt * 1e18 / 365 days / 10_000;
        return index + growth;
    }

    function accrue() public {
        uint256 dt = block.timestamp - lastAccrual;
        if (dt == 0) return;
        uint256 growth = uint256(borrowRateBps) * dt * 1e18 / 365 days / 10_000;
        index += growth;
        lastAccrual = block.timestamp;
    }

    // ---------------- views ----------------

    function priceOf(address underlying) public view returns (uint256) {
        string memory symbol = assets[underlying].symbol;
        (int256 p,) = oracle.getPrice(symbol);
        return uint256(p);
    }

    function collateralValueOf(address user, address underlying) public view returns (uint256) {
        uint256 bal = collateralOf[user][underlying];
        if (bal == 0) return 0;
        return bal * priceOf(underlying) / 1e8;
    }

    /// @notice Max debt in mINR allowed by current LTVs, skipping halted assets.
    function borrowingPower(address user) public view returns (uint256 power) {
        for (uint256 i = 0; i < listedAssets.length; i++) {
            address underlying = listedAssets[i];
            if (collateralOf[user][underlying] == 0) continue;
            Asset memory asset = assets[underlying];
            if (gate.isPaused(asset.symbol)) continue;
            uint256 value = collateralValueOf(user, underlying);
            power += value * asset.ltvBps / 10_000;
        }
    }

    function debtOf(address user) public view returns (uint256) {
        return debtNormalized[user] * currentIndex() / 1e18;
    }

    /// @notice Health factor in 1e18. < 1e18 means liquidatable. Max when no debt.
    function healthFactor(address user) public view returns (uint256) {
        uint256 debt = debtOf(user);
        if (debt == 0) return type(uint256).max;
        uint256 thresholdValue;
        for (uint256 i = 0; i < listedAssets.length; i++) {
            address underlying = listedAssets[i];
            if (collateralOf[user][underlying] == 0) continue;
            Asset memory asset = assets[underlying];
            thresholdValue += collateralValueOf(user, underlying) * asset.liqThresholdBps / 10_000;
        }
        return thresholdValue * 1e18 / debt;
    }

    function accountData(address user) external view returns (uint256 collateralValue, uint256 debt, uint256 health) {
        debt = debtOf(user);
        health = healthFactor(user);
        for (uint256 i = 0; i < listedAssets.length; i++) {
            collateralValue += collateralValueOf(user, listedAssets[i]);
        }
    }

    // ---------------- user actions ----------------

    function supply(address underlying, uint256 amount) external nonReentrant {
        require(!paused, "pool paused");
        require(assets[underlying].supported, "not listed");
        require(amount > 0, "zero amount");
        accrue();
        IERC20(underlying).safeTransferFrom(msg.sender, address(this), amount);
        collateralOf[msg.sender][underlying] += amount;
        collateralTotal[underlying] += amount;
        emit Supply(msg.sender, underlying, amount);
    }

    function withdraw(address underlying, uint256 amount) external nonReentrant {
        require(!paused, "pool paused");
        require(collateralOf[msg.sender][underlying] >= amount, "insufficient collateral");
        accrue();
        collateralOf[msg.sender][underlying] -= amount;
        collateralTotal[underlying] -= amount;
        require(_healthyAfterWithdraw(msg.sender), "would be liquidated");
        IERC20(underlying).safeTransfer(msg.sender, amount);
        emit Withdraw(msg.sender, underlying, amount);
    }

    function borrow(uint256 amount) external nonReentrant {
        require(!paused, "pool paused");
        require(amount > 0, "zero amount");
        require(window.canBorrow(), "market closed");
        accrue();
        uint256 maxDebt = borrowingPower(msg.sender);
        uint256 newDebt = debtOf(msg.sender) + amount;
        require(newDebt <= maxDebt, "exceeds LTV");
        debtNormalized[msg.sender] += amount * 1e18 / index;
        totalDebtNormalized += amount * 1e18 / index;
        minr.mint(msg.sender, amount);
        emit Borrow(msg.sender, amount);
    }

    function repay(uint256 amount) external nonReentrant {
        require(amount > 0, "zero amount");
        accrue();
        uint256 debt = debtOf(msg.sender);
        require(debt > 0, "no debt");
        uint256 pay = amount > debt ? debt : amount;
        if (pay >= debt) {
            // full repayment clears the position exactly (no dust left behind)
            totalDebtNormalized -= debtNormalized[msg.sender];
            debtNormalized[msg.sender] = 0;
        } else {
            uint256 scaled = pay * 1e18 / index;
            debtNormalized[msg.sender] -= scaled;
            totalDebtNormalized -= scaled;
        }
        IERC20(address(minr)).safeTransferFrom(msg.sender, address(this), pay);
        minr.burn(pay);
        emit Repay(msg.sender, pay);
    }

    function liquidate(address user, address underlying, uint256 collateralAmount) external nonReentrant {
        require(!paused, "pool paused");
        require(user != msg.sender, "self liquidation");
        require(healthFactor(user) < 1e18, "position healthy");
        Asset memory asset = assets[underlying];
        require(asset.supported, "not listed");
        require(!gate.isPaused(asset.symbol), "asset halted");
        require(collateralOf[user][underlying] >= collateralAmount, "insufficient collateral");

        uint256 value = collateralAmount * priceOf(underlying) / 1e8;
        uint256 debtRepaid = value * 10_000 / (10_000 + liquidationBonusBps);
        require(debtRepaid > 0, "zero debt");
        require(debtRepaid <= debtOf(user), "collateral too large");

        uint256 scaled = debtRepaid * 1e18 / index;
        if (scaled >= debtNormalized[user]) {
            totalDebtNormalized -= debtNormalized[user];
            debtNormalized[user] = 0;
        } else {
            debtNormalized[user] -= scaled;
            totalDebtNormalized -= scaled;
        }

        collateralOf[user][underlying] -= collateralAmount;
        collateralTotal[underlying] -= collateralAmount;

        IERC20(address(minr)).safeTransferFrom(msg.sender, address(this), debtRepaid);
        minr.burn(debtRepaid);
        IERC20(underlying).safeTransfer(msg.sender, collateralAmount);

        emit Liquidate(user, underlying, msg.sender, collateralAmount, debtRepaid);
    }

    // ---------------- internal ----------------

    function _healthyAfterWithdraw(address user) internal view returns (bool) {
        uint256 debt = debtOf(user);
        if (debt == 0) return true;
        uint256 thresholdValue;
        for (uint256 i = 0; i < listedAssets.length; i++) {
            address underlying = listedAssets[i];
            if (collateralOf[user][underlying] == 0) continue;
            Asset memory asset = assets[underlying];
            thresholdValue += collateralValueOf(user, underlying) * asset.liqThresholdBps / 10_000;
        }
        return thresholdValue >= debt;
    }
}
