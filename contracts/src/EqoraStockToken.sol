// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title EqoraStockToken
 * @notice Synthetic Indian stock token for the EQORA practice terminal.
 *         1 token = 1 synthetic share of an NSE-listed company or index.
 *         DEMO ONLY: these tokens represent no real equity, no claim on any
 *         company, and are not securities. Price discovery happens in the
 *         EqoraPriceOracle, driven by delayed public market data.
 */
contract EqoraStockToken is ERC20, Ownable {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}
