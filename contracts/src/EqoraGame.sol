// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import {EqoraPriceOracle} from "./EqoraPriceOracle.sol";
import {EqoraMINR} from "./EqoraMINR.sol";

/**
 * @title EqoraGame
 * @notice Instant-spot venue for the EQORA practice terminal: users swap the
 *         demo rupee (mINR) for synthetic NSE shares and back at the oracle
 *         price. The contract holds the share inventory and the mINR reserve,
 *         so every fill is a single atomic wallet confirmation — no order
 *         book, no partial fills, no counterparty risk.
 *
 *         Quoting is two-sided and honest about cost:
 *         - prices come from the EqoraPriceOracle (8 decimals, INR per share)
 *           and are refused when older than `maxQuoteAge`;
 *         - a small execution fee (`feeBps`, default 0.30%) is taken from the
 *           traded amount and stays in the contract as treasury — it is
 *           already inside the quoted output, never charged on top.
 *
 *         The ticket UI quotes with `quoteBuy` / `quoteSell`, the user
 *         reviews, then confirms `buyStock` / `sellStock` with a minimum
 *         output so a price push between review and confirmation cannot
 *         deliver a worse fill.
 *
 *         DEMO ONLY: synthetic shares, no real equity, no real rupees.
 *         Original work for the EQORA submission.
 */
contract EqoraGame is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    EqoraPriceOracle public immutable oracle;
    EqoraMINR public immutable minr;

    /// @notice Execution fee, taken from the traded amount, kept in treasury.
    uint16 public feeBps = 30; // 0.30%

    /// @notice Max age of an oracle push the venue will trade against.
    ///         Delayed public market data is the premise of this terminal;
    ///         the tolerance keeps trading alive across reporter gaps.
    uint64 public maxQuoteAge = 6 hours;

    bool public paused;

    mapping(address => string) private _symbol; // stock token => oracle key
    address[] private _stocks;

    event StockListed(address indexed stock, string symbol);
    event StockUnlisted(address indexed stock);
    event StockBought(address indexed player, address indexed stock, uint256 minrIn, uint256 sharesOut, uint256 price);
    event StockSold(address indexed player, address indexed stock, uint256 sharesIn, uint256 minrOut, uint256 price);
    event FeeSet(uint16 bps);
    event MaxQuoteAgeSet(uint64 seconds_);
    event PausedSet(bool paused_);
    event StockWithdrawn(address indexed stock, address indexed to, uint256 amount);
    event MinrWithdrawn(address indexed to, uint256 amount);

    constructor(EqoraPriceOracle oracle_, EqoraMINR minr_) {
        oracle = oracle_;
        minr = minr_;
    }

    // ---------------- admin ----------------

    function listStock(address stock, string calldata symbol) external onlyOwner {
        require(stock != address(0) && bytes(symbol).length > 0, "bad stock");
        require(bytes(_symbol[stock]).length == 0, "already listed");
        _symbol[stock] = symbol;
        _stocks.push(stock);
        emit StockListed(stock, symbol);
    }

    function unlistStock(address stock) external onlyOwner {
        require(bytes(_symbol[stock]).length > 0, "not listed");
        delete _symbol[stock];
        for (uint256 i = 0; i < _stocks.length; i++) {
            if (_stocks[i] == stock) {
                _stocks[i] = _stocks[_stocks.length - 1];
                _stocks.pop();
                break;
            }
        }
        emit StockUnlisted(stock);
    }

    function setFee(uint16 bps) external onlyOwner {
        require(bps <= 500, "fee too high"); // hard cap 5%
        feeBps = bps;
        emit FeeSet(bps);
    }

    function setMaxQuoteAge(uint64 seconds_) external onlyOwner {
        require(seconds_ >= 60, "too short");
        maxQuoteAge = seconds_;
        emit MaxQuoteAgeSet(seconds_);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function withdrawStock(address stock, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "bad to");
        IERC20(stock).safeTransfer(to, amount);
        emit StockWithdrawn(stock, to, amount);
    }

    function withdrawMinr(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "bad to");
        IERC20(address(minr)).safeTransfer(to, amount);
        emit MinrWithdrawn(to, amount);
    }

    // ---------------- views ----------------

    function stockSymbol(address stock) public view returns (string memory) {
        return _symbol[stock];
    }

    function isListed(address stock) external view returns (bool) {
        return bytes(_symbol[stock]).length > 0;
    }

    function stocks() external view returns (address[] memory) {
        return _stocks;
    }

    /// @notice Share inventory the venue can sell right now.
    function inventoryOf(address stock) external view returns (uint256) {
        return IERC20(stock).balanceOf(address(this));
    }

    /// @notice mINR the venue can pay out on sells right now.
    function reserveBalance() external view returns (uint256) {
        return minr.balanceOf(address(this));
    }

    /// @notice Oracle price for a listed stock, refused when older than maxQuoteAge.
    function priceOf(address stock) public view returns (uint256 price) {
        string memory symbol = _symbol[stock];
        require(bytes(symbol).length > 0, "not listed");
        (int256 p, uint64 updatedAt) = oracle.getRawPrice(symbol);
        require(p > 0, "no price");
        require(updatedAt != 0 && block.timestamp - updatedAt <= maxQuoteAge, "stale price");
        price = uint256(p);
    }

    /// @notice Shares received for `minrAmount` mINR, fee-inclusive.
    function quoteBuy(address stock, uint256 minrAmount) public view returns (uint256 shares, uint256 price) {
        price = priceOf(stock);
        if (minrAmount == 0) return (0, price);
        shares = minrAmount * uint256(10_000 - feeBps) * 1e8 / 10_000 / price;
    }

    /// @notice mINR received for `shares`, fee-inclusive.
    function quoteSell(address stock, uint256 shares) public view returns (uint256 minrOut, uint256 price) {
        price = priceOf(stock);
        if (shares == 0) return (0, price);
        minrOut = shares * price * uint256(10_000 - feeBps) / 10_000 / 1e8;
    }

    // ---------------- trading ----------------

    /// @notice Swap mINR for shares. `minShares` protects the reviewed quote.
    function buyStock(address stock, uint256 minrAmount, uint256 minShares) external nonReentrant returns (uint256 shares) {
        require(!paused, "paused");
        require(minrAmount > 0, "zero amount");
        uint256 price;
        (shares, price) = quoteBuy(stock, minrAmount);
        require(shares > 0, "amount too small");
        require(shares >= minShares, "slippage");
        require(IERC20(stock).balanceOf(address(this)) >= shares, "no inventory");

        IERC20(address(minr)).safeTransferFrom(msg.sender, address(this), minrAmount);
        IERC20(stock).safeTransfer(msg.sender, shares);

        emit StockBought(msg.sender, stock, minrAmount, shares, price);
    }

    /// @notice Swap shares for mINR. `minMInr` protects the reviewed quote.
    function sellStock(address stock, uint256 shares, uint256 minMInr) external nonReentrant returns (uint256 minrOut) {
        require(!paused, "paused");
        require(shares > 0, "zero shares");
        uint256 price;
        (minrOut, price) = quoteSell(stock, shares);
        require(minrOut > 0, "amount too small");
        require(minrOut >= minMInr, "slippage");
        require(minr.balanceOf(address(this)) >= minrOut, "no reserve");

        IERC20(stock).safeTransferFrom(msg.sender, address(this), shares);
        IERC20(address(minr)).safeTransfer(msg.sender, minrOut);

        emit StockSold(msg.sender, stock, shares, minrOut, price);
    }
}
